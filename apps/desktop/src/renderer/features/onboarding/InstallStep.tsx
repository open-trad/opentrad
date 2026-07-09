// CC 安装引导（M1 #21 / open-trad/opentrad#21 OnboardingStep1）。
//
// 三种用户路径：
// 1. 自动安装（macOS / Linux）：点"一键安装" → 后端 PTY spawn install.sh →
//    TerminalPane 显示输出 → install.sh 退出后启动 detect-loop 等 installed=true
// 2. 手动安装（Windows，A3 降级）：UI 显示 docs.claude.com 链接 + "已安装,继续"
//    按钮 → 点击后启动 detect-loop
// 3. 跳过引导：进 main 但保持 onboarded=false（issue body 验收要求）
//
// 视觉分组（manual 路径）：info 提示 → 文档链接 → 操作按钮，"为什么 → 怎么办 → 做完了"
// 隐私（auto 路径）：UI 醒目提示安装命令直接来自 claude.ai 官方，可读完再决定。

import type {
  CCStatus,
  InstallerSupportsAutoInstallResponse,
  PtyDataEvent,
} from "@opentrad/shared";
import { ExternalLink, Loader2 } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";

export interface InstallStepProps {
  // 已 installed 时回调（detect-loop 推 cc:status 自动触发）
  onInstalled: (status: CCStatus) => void;
  // 用户主动跳过引导
  onSkip: () => void;
}

type ReadyPhase = {
  kind: "ready";
  support: InstallerSupportsAutoInstallResponse;
  status: CCStatus;
};
type InstallingPhase = {
  kind: "installing";
  ptyId: string;
  lines: string[];
  support: InstallerSupportsAutoInstallResponse;
};
type DetectingPhase = {
  kind: "detecting";
  support: InstallerSupportsAutoInstallResponse;
};

type Phase =
  | { kind: "loading" }
  | ReadyPhase
  | InstallingPhase
  | DetectingPhase
  | { kind: "error"; message: string };

const ISSUES_URL = "https://github.com/open-trad/opentrad/issues";

export function InstallStep({ onInstalled, onSkip }: InstallStepProps): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  // 初次加载：探平台支持 + 当前 cc:status
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [support, status] = await Promise.all([
          window.api.installer.supportsAutoInstall(),
          window.api.cc.status(),
        ]);
        if (cancelled) return;
        if (status.installed) {
          // 已经装好,直接推进(不进 onboarding)
          onInstalled(status);
          return;
        }
        setPhase({ kind: "ready", support, status });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setPhase({ kind: "error", message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onInstalled]);

  // 监听 cc:status push（detect-loop 触发的）
  useEffect(() => {
    const unsubscribe = window.api.cc.onStatus((status) => {
      if (status.installed) {
        // 自动停 detect-loop 由 main 端做（推到 installed=true 后内部 stop）
        onInstalled(status);
      }
    });
    return unsubscribe;
  }, [onInstalled]);

  const handleAutoInstall = async (): Promise<void> => {
    if (phase.kind !== "ready") return;
    try {
      const { ptyId } = await window.api.installer.runCcInstall();
      setPhase({ kind: "installing", ptyId, lines: [], support: phase.support });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPhase({ kind: "error", message });
    }
  };

  // PTY 数据流 + 退出（installing 阶段）
  useEffect(() => {
    if (phase.kind !== "installing") return;
    const ptyId = phase.ptyId;
    const support = phase.support;

    const offData = window.api.pty.onData((evt: PtyDataEvent) => {
      if (evt.ptyId !== ptyId) return;
      setPhase((prev) =>
        prev.kind === "installing" && prev.ptyId === ptyId
          ? { ...prev, lines: [...prev.lines, evt.data] }
          : prev,
      );
    });
    const offExit = window.api.pty.onExit((evt) => {
      if (evt.ptyId !== ptyId) return;
      // PTY 退出后启动 detect-loop（每 3s 检测一次,5min 兜底）
      void window.api.cc.detectLoopStart({ intervalMs: 3000, maxDurationMs: 5 * 60 * 1000 });
      setPhase({ kind: "detecting", support });
    });

    return () => {
      offData();
      offExit();
    };
  }, [phase]);

  const handleAlreadyInstalled = (): void => {
    if (phase.kind !== "ready") return;
    void window.api.cc.detectLoopStart({ intervalMs: 3000, maxDurationMs: 60 * 1000 });
    setPhase({ kind: "detecting", support: phase.support });
  };

  // ----- 渲染 -----

  const palette = {
    cardBg: "#fff",
    border: "#e5e7eb",
    primary: "#2563eb",
    text: "#111827",
    muted: "#6b7280",
    info: "#dbeafe",
    infoText: "#1e3a8a",
    soft: "#f3f4f6",
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

  // 底部小字链接（兜底求助 + 跳过引导）
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
        安装遇到问题?
      </a>
      <button type="button" onClick={onSkip} style={footerLinkStyle}>
        暂时跳过(部分功能不可用)
      </button>
    </div>
  );

  if (phase.kind === "loading") {
    return (
      <div style={containerStyle}>
        <SpinKeyframes />
        <div style={cardStyle}>
          <div style={{ color: palette.muted }}>检测中…</div>
        </div>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div style={containerStyle}>
        <SpinKeyframes />
        <div style={cardStyle}>
          <h2 style={{ margin: "0 0 1rem", color: "#b91c1c" }}>初始化失败</h2>
          <pre
            style={{
              background: "#fef2f2",
              padding: "1rem",
              borderRadius: 6,
              fontSize: "0.85rem",
              overflow: "auto",
            }}
          >
            {phase.message}
          </pre>
        </div>
        {footer}
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <SpinKeyframes />
      <div style={cardStyle}>
        <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.5rem" }}>欢迎使用 OpenTrad</h1>
        <p style={{ margin: "0 0 1.5rem", color: palette.muted }}>第 1 步:安装 Claude Code</p>

        {phase.support.supportsAutoInstall ? (
          <AutoInstallSection
            phase={phase}
            onAutoInstall={handleAutoInstall}
            buttonPrimary={buttonPrimary}
            palette={palette}
          />
        ) : (
          <ManualInstallSection
            support={phase.support}
            onAlreadyInstalled={handleAlreadyInstalled}
            buttonPrimary={buttonPrimary}
            palette={palette}
            phase={phase}
          />
        )}
      </div>
      {footer}
    </div>
  );
}

// inline keyframes 注入：避免引 Tailwind / 全局 CSS
function SpinKeyframes(): ReactElement {
  return (
    <style>{`@keyframes opentrad-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
  );
}

const spinIconStyle: React.CSSProperties = {
  animation: "opentrad-spin 1s linear infinite",
};

interface SectionPalette {
  muted: string;
  info: string;
  infoText: string;
  border: string;
  soft: string;
  primary: string;
}

interface AutoInstallSectionProps {
  phase: ReadyPhase | InstallingPhase | DetectingPhase;
  onAutoInstall: () => void;
  buttonPrimary: React.CSSProperties;
  palette: SectionPalette;
}

function AutoInstallSection({
  phase,
  onAutoInstall,
  buttonPrimary,
  palette,
}: AutoInstallSectionProps): ReactElement {
  return (
    <div>
      <div
        style={{
          background: palette.info,
          padding: "0.75rem 1rem",
          borderRadius: 6,
          fontSize: "0.85rem",
          marginBottom: "1rem",
          color: palette.infoText,
        }}
      >
        🛡 安装命令直接来自 claude.ai 官方:
        <code style={{ display: "block", marginTop: "0.5rem", fontFamily: "monospace" }}>
          curl -fsSL https://claude.ai/install.sh | bash
        </code>
        <span style={{ display: "block", marginTop: "0.5rem", fontSize: "0.8rem" }}>
          你可以读完命令再决定是否执行。OpenTrad 不读 ~/.claude / 不存任何 token。
        </span>
      </div>

      {phase.kind === "ready" ? (
        <button type="button" onClick={onAutoInstall} style={buttonPrimary}>
          一键安装 Claude Code
        </button>
      ) : null}

      {phase.kind === "installing" ? (
        <div>
          <div style={{ fontSize: "0.85rem", color: palette.muted, marginBottom: "0.5rem" }}>
            正在安装(完成后自动检测)…
          </div>
          <pre
            style={{
              background: "#0f172a",
              color: "#e2e8f0",
              padding: "0.75rem",
              borderRadius: 6,
              maxHeight: 280,
              overflow: "auto",
              fontSize: "0.8rem",
              whiteSpace: "pre-wrap",
              fontFamily: '"SF Mono", Menlo, Monaco, monospace',
            }}
          >
            {phase.lines.join("")}
          </pre>
        </div>
      ) : null}

      {phase.kind === "detecting" ? (
        <DetectingIndicator palette={palette} hintMaxText="最多等待 5 分钟" />
      ) : null}
    </div>
  );
}

interface ManualInstallSectionProps {
  support: InstallerSupportsAutoInstallResponse;
  onAlreadyInstalled: () => void;
  buttonPrimary: React.CSSProperties;
  palette: SectionPalette;
  // 接受 union 简化父组件类型;installing 在 manual 路径运行时不会出现
  // (只 auto 路径转入),渲染层降级当 ready 处理
  phase: ReadyPhase | InstallingPhase | DetectingPhase;
}

function ManualInstallSection({
  support,
  onAlreadyInstalled,
  buttonPrimary,
  palette,
  phase,
}: ManualInstallSectionProps): ReactElement {
  return (
    <div>
      {/* 第 1 段:为什么(蓝底 info) */}
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
        Windows 上需要手动安装 Claude Code。点击下方链接按官方文档完成安装,然后回到这里继续。
      </div>

      {/* 第 2 段:怎么办(浅灰底 + 外链 icon) */}
      <div
        style={{
          background: palette.soft,
          border: `1px solid ${palette.border}`,
          padding: "0.75rem 1rem",
          borderRadius: 6,
          marginBottom: "1.25rem",
        }}
      >
        <a
          href={support.manualInstallUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault();
            window.open(support.manualInstallUrl, "_blank", "noopener,noreferrer");
          }}
          style={{
            color: palette.primary,
            textDecoration: "underline",
            fontSize: "0.95rem",
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
          }}
        >
          打开官方安装文档
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>

      {/* 第 3 段:做完了(主按钮) */}
      <button
        type="button"
        onClick={onAlreadyInstalled}
        style={buttonPrimary}
        disabled={phase.kind === "detecting"}
      >
        {phase.kind === "detecting" ? "检测中…" : "已安装,继续"}
      </button>

      {phase.kind === "detecting" ? (
        <DetectingIndicator palette={palette} hintMaxText="最多等待 1 分钟" />
      ) : null}
    </div>
  );
}

function DetectingIndicator({
  palette,
  hintMaxText,
}: {
  palette: { muted: string };
  hintMaxText: string;
}): ReactElement {
  return (
    <div
      style={{
        marginTop: "1rem",
        display: "inline-flex",
        alignItems: "center",
        gap: "0.5rem",
        color: palette.muted,
        fontSize: "0.9rem",
      }}
    >
      <Loader2 size={16} style={spinIconStyle} aria-hidden="true" />
      <span>正在检测 Claude Code({hintMaxText})…</span>
    </div>
  );
}
