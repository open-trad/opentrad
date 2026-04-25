// CC 安装引导（M1 #21 / open-trad/opentrad#21 OnboardingStep1）。
//
// 三种用户路径：
// 1. 自动安装（macOS / Linux）：点"一键安装" → 后端 PTY spawn install.sh →
//    TerminalPane 显示输出 → install.sh 退出后启动 detect-loop 等 installed=true
// 2. 手动安装（Windows，A3 降级）：UI 显示 docs.claude.com 链接 + "我已装好"
//    按钮 → 点击后启动 detect-loop
// 3. 跳过引导：进 main 但保持 onboarded=false（issue body 验收要求）
//
// 隐私：UI 醒目提示安装命令直接来自 claude.ai 官方，可读完再决定。

import type {
  CCStatus,
  InstallerSupportsAutoInstallResponse,
  PtyDataEvent,
} from "@opentrad/shared";
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
          // 已经装好，直接推进（不进 onboarding）
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
      // PTY 退出后启动 detect-loop（每 3s 检测一次，5min 兜底）
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
    bg: "#0f172a",
    cardBg: "#fff",
    border: "#e5e7eb",
    primary: "#2563eb",
    text: "#111827",
    muted: "#6b7280",
    accent: "#dbeafe",
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

  if (phase.kind === "loading") {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <div style={{ color: palette.muted }}>检测中…</div>
        </div>
      </div>
    );
  }

  if (phase.kind === "error") {
    return (
      <div style={containerStyle}>
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
          <button type="button" onClick={onSkip} style={{ ...buttonSecondary, marginTop: "1rem" }}>
            跳过引导
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h1 style={{ margin: "0 0 0.5rem", fontSize: "1.5rem" }}>欢迎使用 OpenTrad</h1>
        <p style={{ margin: "0 0 1.5rem", color: palette.muted }}>第 1 步:安装 Claude Code</p>

        {/* 自动安装路径（macOS / Linux）*/}
        {phase.support.supportsAutoInstall ? (
          <AutoInstallSection
            phase={phase}
            onAutoInstall={handleAutoInstall}
            buttonPrimary={buttonPrimary}
            buttonSecondary={buttonSecondary}
            palette={palette}
            onSkip={onSkip}
          />
        ) : (
          <ManualInstallSection
            support={phase.support}
            onAlreadyInstalled={handleAlreadyInstalled}
            buttonPrimary={buttonPrimary}
            buttonSecondary={buttonSecondary}
            palette={palette}
            onSkip={onSkip}
            phase={phase}
          />
        )}
      </div>
    </div>
  );
}

interface SectionProps {
  buttonPrimary: React.CSSProperties;
  buttonSecondary: React.CSSProperties;
  palette: { muted: string; accent: string; border: string };
  onSkip: () => void;
}

interface AutoInstallSectionProps extends SectionProps {
  phase: ReadyPhase | InstallingPhase | DetectingPhase;
  onAutoInstall: () => void;
}

function AutoInstallSection({
  phase,
  onAutoInstall,
  buttonPrimary,
  buttonSecondary,
  palette,
  onSkip,
}: AutoInstallSectionProps): ReactElement {
  return (
    <div>
      <div
        style={{
          background: palette.accent,
          padding: "0.75rem 1rem",
          borderRadius: 6,
          fontSize: "0.85rem",
          marginBottom: "1rem",
          color: "#1e3a8a",
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
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <button type="button" onClick={onAutoInstall} style={buttonPrimary}>
            一键安装 Claude Code
          </button>
          <button type="button" onClick={onSkip} style={buttonSecondary}>
            跳过引导
          </button>
        </div>
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
        <div style={{ color: palette.muted, fontSize: "0.9rem" }}>
          正在检测安装是否完成…(每 3 秒查一次,最长 5 分钟)
        </div>
      ) : null}
    </div>
  );
}

interface ManualInstallSectionProps extends SectionProps {
  support: InstallerSupportsAutoInstallResponse;
  onAlreadyInstalled: () => void;
  // 接受 union 简化父组件类型；installing 在 manual 路径运行时不会出现
  // （只 auto 路径转入），渲染层降级当 ready 处理
  phase: ReadyPhase | InstallingPhase | DetectingPhase;
}

function ManualInstallSection({
  support,
  onAlreadyInstalled,
  buttonPrimary,
  buttonSecondary,
  palette,
  onSkip,
  phase,
}: ManualInstallSectionProps): ReactElement {
  return (
    <div>
      <div
        style={{
          background: "#fef3c7",
          padding: "0.75rem 1rem",
          borderRadius: 6,
          fontSize: "0.9rem",
          marginBottom: "1rem",
          color: "#92400e",
        }}
      >
        OpenTrad 当前在 <strong>{support.platform}</strong> 上不提供自动安装 Claude
        Code。请按官方文档手动安装,装完后点"我已装好"按钮。
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <a
          href={support.manualInstallUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault();
            // shell.openExternal 会被 main 进程 IPC 拦截;此处直接打开外链
            window.open(support.manualInstallUrl, "_blank", "noopener,noreferrer");
          }}
          style={{
            color: "#2563eb",
            textDecoration: "underline",
            fontSize: "0.95rem",
          }}
        >
          打开官方安装文档 →
        </a>
      </div>

      <div style={{ display: "flex", gap: "0.75rem" }}>
        <button
          type="button"
          onClick={onAlreadyInstalled}
          style={buttonPrimary}
          disabled={phase.kind === "detecting"}
        >
          {phase.kind === "detecting" ? "检测中…" : "我已装好,重新检测"}
        </button>
        <button type="button" onClick={onSkip} style={buttonSecondary}>
          跳过引导
        </button>
      </div>

      {phase.kind === "detecting" ? (
        <div style={{ marginTop: "1rem", color: palette.muted, fontSize: "0.85rem" }}>
          正在检测…(每 3 秒查一次,1 分钟超时)
        </div>
      ) : null}
    </div>
  );
}
