// CC 登录引导(M1 #22 / open-trad/opentrad#22 OnboardingStep2)。
//
// 两条登录路径:
// 1. claudeai (主):点"登录 Claude" → 主进程 spawn `claude auth login --claudeai`
//    PTY → 输出包含 https://claude.ai/oauth/... URL → renderer regex 抽 →
//    用户点"在浏览器中打开登录页" → shell.openExternal → 浏览器完成 →
//    5s polling cc:status detect loggedIn=true → 自动 onLoggedIn 跳 step 3
// 2. apikey (备选):点"使用 API key 登录" → 输入框 → submit → 主进程 spawn
//    `claude auth login --apiKey <KEY>` → 同样 detect loop
//
// timeout(通报点 2 发起人 ack):detecting 阶段最长 5 分钟。超时显示错误,
// 用户可"重新登录"或"跳过引导"。
//
// 视觉沿 #21 InstallStep:蓝底 info / 主按钮 / 底部 footer(GitHub issues + 跳过)。
// 通报点 3:登录成功直接进主界面,不带 1 秒"登录成功"提示(发起人选)。

import type { CCStatus, PtyDataEvent } from "@opentrad/shared";
import { ExternalLink, Loader2 } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";

export interface LoginStepProps {
  status: CCStatus;
  onLoggedIn: () => void;
  onSkip: () => void;
}

const ISSUES_URL = "https://github.com/open-trad/opentrad/issues";
const DETECT_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟(通报点 2)
const DETECT_INTERVAL_MS = 5_000; // 5 秒 polling(issue body §验收)

// renderer 端 URL 提取(与 main services/auth-login.ts CLAUDE_AI_URL_REGEX 同款)
const CLAUDE_AI_URL_REGEX = /https:\/\/claude\.ai\/[\w\-./~:?#@!$&'()*+,;=%]+/g;
function extractClaudeAiUrl(text: string): string | undefined {
  const matches = text.match(CLAUDE_AI_URL_REGEX);
  return matches?.[0];
}

type RunningPhase = {
  kind: "running";
  method: "claudeai" | "apikey";
  ptyId: string;
  lines: string[];
  loginUrl?: string;
};
type DetectingPhase = {
  kind: "detecting";
  method: "claudeai" | "apikey";
  lines: string[];
  startedAt: number;
};
type Phase =
  | { kind: "ready" }
  | { kind: "apikey-input"; value: string }
  | RunningPhase
  | DetectingPhase
  | { kind: "error"; message: string; lines?: string[] };

export function LoginStep({ status, onLoggedIn, onSkip }: LoginStepProps): ReactElement {
  // 已登录直接推进(install step → login step 时若已 loggedIn,通报点 3 不带提示)
  useEffect(() => {
    if (status.loggedIn) {
      onLoggedIn();
    }
  }, [status.loggedIn, onLoggedIn]);

  const [phase, setPhase] = useState<Phase>({ kind: "ready" });

  // PTY 数据流订阅(running 阶段)
  useEffect(() => {
    if (phase.kind !== "running") return;
    const ptyId = phase.ptyId;

    const offData = window.api.pty.onData((evt: PtyDataEvent) => {
      if (evt.ptyId !== ptyId) return;
      setPhase((prev) => {
        if (prev.kind !== "running" || prev.ptyId !== ptyId) return prev;
        const newLines = [...prev.lines, evt.data];
        const detectedUrl = extractClaudeAiUrl(newLines.join(""));
        return { ...prev, lines: newLines, loginUrl: detectedUrl ?? prev.loginUrl };
      });
    });
    const offExit = window.api.pty.onExit((evt) => {
      if (evt.ptyId !== ptyId) return;
      setPhase((prev) => {
        if (prev.kind !== "running" || prev.ptyId !== ptyId) return prev;
        // PTY 退出 → 进 detecting(无论 exit code,polling 决定 success/fail/timeout)
        return {
          kind: "detecting",
          method: prev.method,
          lines: prev.lines,
          startedAt: Date.now(),
        };
      });
    });

    return () => {
      offData();
      offExit();
    };
  }, [phase]);

  // detecting 阶段:5s polling cc:status,5min timeout
  useEffect(() => {
    if (phase.kind !== "detecting") return;
    const startedAt = phase.startedAt;
    const linesSnapshot = phase.lines;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      try {
        const s = await window.api.cc.status();
        if (cancelled) return;
        if (s.installed && s.loggedIn === true) {
          onLoggedIn();
          return;
        }
      } catch {
        // 暂态失败继续 polling
      }
      if (Date.now() - startedAt > DETECT_TIMEOUT_MS) {
        if (!cancelled) {
          setPhase({
            kind: "error",
            message: "登录检测超时(5 分钟)。请重试或跳过引导。",
            lines: linesSnapshot,
          });
        }
      }
    };

    void tick();
    const handle = setInterval(() => void tick(), DETECT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [phase, onLoggedIn]);

  // ----- actions -----

  const startClaudeai = async (): Promise<void> => {
    try {
      const { ptyId } = await window.api.auth.startLoginFlow({ method: "claudeai" });
      setPhase({ kind: "running", method: "claudeai", ptyId, lines: [] });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const submitApiKey = async (apiKey: string): Promise<void> => {
    if (!apiKey.trim()) return;
    try {
      const { ptyId } = await window.api.auth.startLoginFlow({ method: "apikey", apiKey });
      setPhase({ kind: "running", method: "apikey", ptyId, lines: [] });
    } catch (err) {
      setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const cancelRunning = async (): Promise<void> => {
    if (phase.kind === "running") {
      try {
        await window.api.pty.kill({ ptyId: phase.ptyId });
      } catch {
        // PTY 可能已退出,忽略
      }
    }
    setPhase({ kind: "ready" });
  };

  const openLoginUrl = async (url: string): Promise<void> => {
    try {
      await window.api.shell.openExternal({ url });
    } catch (err) {
      console.error("[login-step] shell.openExternal failed", err);
    }
  };

  // ----- 视觉(沿 #21 InstallStep 风格) -----

  const palette = {
    cardBg: "#fff",
    border: "#e5e7eb",
    primary: "#2563eb",
    text: "#111827",
    muted: "#6b7280",
    info: "#dbeafe",
    infoText: "#1e3a8a",
    soft: "#f3f4f6",
    danger: "#b91c1c",
    dangerBg: "#fef2f2",
  };

  const containerStyle: React.CSSProperties = {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "2rem",
    fontFamily: "system-ui, -apple-system, sans-serif",
    color: palette.text,
  };
  const cardStyle: React.CSSProperties = {
    background: palette.cardBg,
    border: `1px solid ${palette.border}`,
    borderRadius: 8,
    padding: "2rem",
    maxWidth: 720,
    width: "100%",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.05)",
  };
  const buttonPrimary: React.CSSProperties = {
    background: palette.primary,
    color: "white",
    border: "none",
    padding: "0.6rem 1.2rem",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: "0.95rem",
  };
  const buttonSecondary: React.CSSProperties = {
    background: "white",
    color: palette.text,
    border: `1px solid ${palette.border}`,
    padding: "0.6rem 1.2rem",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: "0.95rem",
  };
  const footerLinkStyle: React.CSSProperties = {
    color: palette.muted,
    fontSize: "0.8rem",
    textDecoration: "none",
    cursor: "pointer",
    background: "none",
    border: "none",
    padding: 0,
    fontFamily: "inherit",
  };

  const footer = (
    <div
      style={{
        marginTop: "1.25rem",
        display: "flex",
        gap: "1.5rem",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <a
        href={ISSUES_URL}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          e.preventDefault();
          window.open(ISSUES_URL, "_blank", "noopener,noreferrer");
        }}
        style={{ ...footerLinkStyle, textDecoration: "underline" }}
      >
        登录遇到问题?
      </a>
      <button type="button" onClick={onSkip} style={footerLinkStyle}>
        暂时跳过(部分功能不可用)
      </button>
    </div>
  );

  const spinKeyframes = (
    <style>{`@keyframes opentrad-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
  );
  const spinStyle: React.CSSProperties = { animation: "opentrad-spin 1s linear infinite" };

  const ptyOutputBlock = (lines: string[]): ReactElement => (
    <pre
      style={{
        background: "#0f172a",
        color: "#e2e8f0",
        padding: "0.75rem",
        borderRadius: 6,
        maxHeight: 240,
        overflow: "auto",
        fontSize: "0.8rem",
        whiteSpace: "pre-wrap",
        fontFamily: '"SF Mono", Menlo, Monaco, monospace',
        marginTop: "1rem",
      }}
    >
      {lines.join("")}
    </pre>
  );

  const header = (
    <>
      <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.5rem" }}>欢迎使用 OpenTrad</h1>
      <p style={{ margin: "0 0 1.5rem", color: palette.muted }}>第 2 步:登录 Claude</p>
    </>
  );

  // ----- 各 phase 渲染 -----

  if (phase.kind === "ready") {
    return (
      <div style={containerStyle}>
        {spinKeyframes}
        <div style={cardStyle}>
          {header}
          <div
            style={{
              background: palette.info,
              padding: "0.75rem 1rem",
              borderRadius: 6,
              fontSize: "0.9rem",
              marginBottom: "1.25rem",
              color: palette.infoText,
            }}
          >
            Claude Code{status.version ? ` v${status.version}` : ""} 已安装,但还没登录。
            点击下方按钮启动登录流程,会在浏览器中完成账号授权。
          </div>

          <button type="button" onClick={() => void startClaudeai()} style={buttonPrimary}>
            登录 Claude
          </button>

          <div style={{ marginTop: "1rem" }}>
            <button
              type="button"
              onClick={() => setPhase({ kind: "apikey-input", value: "" })}
              style={{ ...footerLinkStyle, textDecoration: "underline" }}
            >
              使用 API key 登录(备选)
            </button>
          </div>
        </div>
        {footer}
      </div>
    );
  }

  if (phase.kind === "apikey-input") {
    return (
      <div style={containerStyle}>
        {spinKeyframes}
        <div style={cardStyle}>
          {header}
          <div
            style={{
              background: palette.info,
              padding: "0.75rem 1rem",
              borderRadius: 6,
              fontSize: "0.9rem",
              marginBottom: "1rem",
              color: palette.infoText,
            }}
          >
            粘贴 Anthropic API key(以 <code>sk-ant-</code> 开头)。OpenTrad 不存储此值,
            提交后立即传给 Claude Code 由它管。
          </div>

          <input
            type="password"
            value={phase.value}
            onChange={(e) => setPhase({ kind: "apikey-input", value: e.target.value })}
            placeholder="sk-ant-..."
            // biome-ignore lint/a11y/noAutofocus: API key 输入是 onboarding modal-like 单一焦点场景,自动聚焦减少键盘用户额外 tab。
            autoFocus
            style={{
              display: "block",
              width: "100%",
              padding: "0.6rem 0.8rem",
              fontSize: "0.95rem",
              border: `1px solid ${palette.border}`,
              borderRadius: 6,
              boxSizing: "border-box",
              fontFamily: "monospace",
              marginBottom: "1rem",
            }}
          />

          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button
              type="button"
              onClick={() => void submitApiKey(phase.value)}
              disabled={!phase.value.trim()}
              style={{
                ...buttonPrimary,
                background: phase.value.trim() ? palette.primary : "#cbd5e1",
                cursor: phase.value.trim() ? "pointer" : "not-allowed",
              }}
            >
              提交
            </button>
            <button
              type="button"
              onClick={() => setPhase({ kind: "ready" })}
              style={buttonSecondary}
            >
              返回
            </button>
          </div>
        </div>
        {footer}
      </div>
    );
  }

  if (phase.kind === "running") {
    return (
      <div style={containerStyle}>
        {spinKeyframes}
        <div style={cardStyle}>
          {header}
          <div
            style={{
              background: palette.info,
              padding: "0.75rem 1rem",
              borderRadius: 6,
              fontSize: "0.9rem",
              marginBottom: "1rem",
              color: palette.infoText,
            }}
          >
            {phase.loginUrl ? (
              <>已生成登录 URL,点击下方按钮在浏览器中完成授权。</>
            ) : phase.method === "claudeai" ? (
              <>正在启动登录流程,等待 Claude Code 生成授权 URL…</>
            ) : (
              <>正在提交 API key…</>
            )}
          </div>

          {phase.loginUrl ? (
            <button
              type="button"
              onClick={() => void openLoginUrl(phase.loginUrl ?? "")}
              style={{
                ...buttonPrimary,
                display: "inline-flex",
                alignItems: "center",
                gap: "0.4rem",
              }}
            >
              在浏览器中打开登录页
              <ExternalLink size={14} aria-hidden="true" />
            </button>
          ) : (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.5rem",
                color: palette.muted,
                fontSize: "0.9rem",
              }}
            >
              <Loader2 size={16} style={spinStyle} aria-hidden="true" />
              <span>等待 URL…</span>
            </div>
          )}

          <div style={{ marginTop: "0.75rem" }}>
            <button type="button" onClick={() => void cancelRunning()} style={buttonSecondary}>
              取消登录
            </button>
          </div>

          {ptyOutputBlock(phase.lines)}
        </div>
        {footer}
      </div>
    );
  }

  if (phase.kind === "detecting") {
    return (
      <div style={containerStyle}>
        {spinKeyframes}
        <div style={cardStyle}>
          {header}
          <div
            style={{
              background: palette.info,
              padding: "0.75rem 1rem",
              borderRadius: 6,
              fontSize: "0.9rem",
              marginBottom: "1rem",
              color: palette.infoText,
            }}
          >
            登录脚本已退出,正在检测登录状态。完成浏览器登录后会自动跳转。
          </div>

          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.5rem",
              color: palette.muted,
              fontSize: "0.9rem",
            }}
          >
            <Loader2 size={16} style={spinStyle} aria-hidden="true" />
            <span>检测中(最多等待 5 分钟)…</span>
          </div>

          {ptyOutputBlock(phase.lines)}
        </div>
        {footer}
      </div>
    );
  }

  // error
  return (
    <div style={containerStyle}>
      {spinKeyframes}
      <div style={cardStyle}>
        {header}
        <div
          style={{
            background: palette.dangerBg,
            color: palette.danger,
            padding: "0.75rem 1rem",
            borderRadius: 6,
            fontSize: "0.9rem",
            marginBottom: "1rem",
          }}
        >
          {phase.message}
        </div>

        <button type="button" onClick={() => setPhase({ kind: "ready" })} style={buttonPrimary}>
          重新登录
        </button>

        {phase.lines && phase.lines.length > 0 ? ptyOutputBlock(phase.lines) : null}
      </div>
      {footer}
    </div>
  );
}
