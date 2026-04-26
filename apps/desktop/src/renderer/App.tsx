// App 组件 — M0 收官（Issue #8）：
// 用户点"Say Hi"按钮 → main spawn CC → stream-json 事件流渲染 → "完成" 标记。
// 不做 markdown（M1）、skill 表单（M1）、MCP 工具（M2）、Risk Gate（M2）。

import type { CCEvent, CCStatus } from "@opentrad/shared";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { TerminalPane } from "./components/ui/TerminalPane";
import { OnboardingGate } from "./features/onboarding/OnboardingGate";

type CcStatusState =
  | { kind: "loading" }
  | { kind: "ready"; data: CCStatus }
  | { kind: "error"; message: string };

type TaskState =
  | { kind: "idle" }
  | { kind: "running"; sessionId: string }
  | { kind: "finished"; sessionId: string; success: boolean };

export function App(): ReactElement {
  return (
    <OnboardingGate>
      <MainApp />
    </OnboardingGate>
  );
}

function MainApp(): ReactElement {
  const [ccStatus, setCcStatus] = useState<CcStatusState>({ kind: "loading" });
  const [task, setTask] = useState<TaskState>({ kind: "idle" });
  const [events, setEvents] = useState<CCEvent[]>([]);
  // M1 #20：PTY 面板默认折叠（02 F1.4 + issue 验收）
  const [ptyOpen, setPtyOpen] = useState(false);

  // 加载 CC 状态一次
  useEffect(() => {
    let cancelled = false;
    window.api.cc
      .status()
      .then((data) => {
        if (!cancelled) setCcStatus({ kind: "ready", data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setCcStatus({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 订阅 CC 事件流（全局一次）
  useEffect(() => {
    const unsubscribe = window.api.cc.onEvent((evt) => {
      setEvents((prev) => [...prev, evt]);
      if (evt.type === "result") {
        setTask((prev) =>
          prev.kind === "running"
            ? {
                kind: "finished",
                sessionId: prev.sessionId,
                success: evt.subtype === "success",
              }
            : prev,
        );
      }
    });
    return unsubscribe;
  }, []);

  const canStart =
    ccStatus.kind === "ready" &&
    ccStatus.data.installed &&
    ccStatus.data.loggedIn === true &&
    task.kind !== "running";

  const onSayHi = async (): Promise<void> => {
    setEvents([]);
    setTask({ kind: "running", sessionId: "pending" });
    try {
      const { sessionId } = await window.api.cc.startTask({
        skillId: "__m0_demo__",
        inputs: {},
      });
      setTask({ kind: "running", sessionId });
    } catch (err) {
      console.error("[App] startTask failed", err);
      setTask({ kind: "idle" });
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#333",
      }}
    >
      <Header ccStatus={ccStatus} task={task} />
      <div style={{ padding: "0 2rem 1rem", textAlign: "center" }}>
        <button
          type="button"
          onClick={onSayHi}
          disabled={!canStart}
          style={{
            padding: "0.6rem 1.5rem",
            fontSize: "1rem",
            borderRadius: 6,
            border: "none",
            background: canStart ? "#2563eb" : "#cbd5e1",
            color: "white",
            cursor: canStart ? "pointer" : "not-allowed",
          }}
        >
          {task.kind === "running" ? "进行中..." : "Say Hi in Chinese"}
        </button>
      </div>
      <EventList events={events} />
      <PtyDrawer open={ptyOpen} onToggle={() => setPtyOpen((v) => !v)} />
    </div>
  );
}

// 底部折叠 Terminal 面板（M1 #20）。默认折叠，点"打开 terminal"才挂载 TerminalPane
// （挂载时才 spawn PTY；折叠回去会 unmount TerminalPane → kill PTY，避免后台 shell 长留）。
function PtyDrawer({ open, onToggle }: { open: boolean; onToggle: () => void }): ReactElement {
  return (
    <div style={{ borderTop: "1px solid #e5e7eb" }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%",
          padding: "0.4rem 1rem",
          textAlign: "left",
          background: "#f8fafc",
          border: "none",
          borderBottom: open ? "1px solid #e5e7eb" : "none",
          cursor: "pointer",
          fontSize: "0.85rem",
          color: "#475569",
        }}
      >
        {open ? "▼ 关闭 terminal" : "▶ 打开 terminal"}
      </button>
      {open ? <TerminalPane height={280} /> : null}
    </div>
  );
}

function Header({ ccStatus, task }: { ccStatus: CcStatusState; task: TaskState }): ReactElement {
  return (
    <header
      style={{
        padding: "1rem 2rem",
        borderBottom: "1px solid #e5e7eb",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <h1 style={{ fontSize: "1.5rem", margin: 0 }}>OpenTrad</h1>
      <div style={{ fontSize: "0.85rem" }}>
        <CcStatusInline state={ccStatus} />
        {task.kind === "finished" ? (
          <span
            style={{
              marginLeft: "1rem",
              color: task.success ? "#166534" : "#b91c1c",
            }}
          >
            {task.success ? "✓ 完成" : "× 失败"}
          </span>
        ) : null}
      </div>
    </header>
  );
}

function CcStatusInline({ state }: { state: CcStatusState }): ReactElement {
  if (state.kind === "loading") {
    return <span style={{ color: "#999" }}>检测中...</span>;
  }
  if (state.kind === "error") {
    return <span style={{ color: "#b91c1c" }}>IPC 错误：{state.message}</span>;
  }
  const s = state.data;
  if (!s.installed) {
    return <span style={{ color: "#92400e" }}>CC 未安装</span>;
  }
  if (!s.loggedIn) {
    // M1 #22:未登录时提供"点击登录"入口,reset onboarded=false + reload renderer
    // 让 OnboardingGate 重新走 install/login 决策树进 LoginStep。
    // M2 视需求改为更平滑路径(无需 reload,直接挂模态登录组件)。
    const handleLoginClick = async (): Promise<void> => {
      try {
        await window.api.settings.set("onboarded", false);
      } finally {
        window.location.reload();
      }
    };
    return (
      <span style={{ color: "#92400e" }}>
        v{s.version} · 未登录,
        <button
          type="button"
          onClick={() => void handleLoginClick()}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            color: "#2563eb",
            textDecoration: "underline",
            cursor: "pointer",
            fontSize: "0.85rem",
            fontFamily: "inherit",
          }}
        >
          点击登录
        </button>
      </span>
    );
  }
  const methodLabel = s.authMethod === "subscription" ? "订阅" : "API";
  return (
    <span style={{ color: "#166534" }}>
      v{s.version} · {s.email ?? "(?)"}（{methodLabel}）
    </span>
  );
}

function EventList({ events }: { events: CCEvent[] }): ReactElement {
  if (events.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#9ca3af",
        }}
      >
        点按钮发送 "Say Hi in Chinese" 到 Claude Code
      </div>
    );
  }
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "0 2rem 2rem" }}>
      {events.map((evt, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: event list is append-only, order is stable
        <EventCard key={`${i}-${evt.type}`} evt={evt} />
      ))}
    </div>
  );
}

function EventCard({ evt }: { evt: CCEvent }): ReactElement {
  switch (evt.type) {
    case "system":
      return (
        <Card tone="neutral">
          <strong>system/init</strong>
          <div style={{ fontSize: "0.8rem", color: "#666" }}>
            model={evt.data.model} · cc={evt.data.claudeCodeVersion}
          </div>
        </Card>
      );
    case "rate_limit_event":
      return (
        <Card tone="warning">
          <strong>rate limit</strong>
          <div style={{ fontSize: "0.8rem" }}>
            type={evt.rateLimitInfo.rateLimitType} · status={evt.rateLimitInfo.status}
          </div>
        </Card>
      );
    case "assistant_thinking":
      return (
        <Card tone="thinking">
          <details>
            <summary style={{ cursor: "pointer", color: "#64748b" }}>思考过程</summary>
            <div style={{ whiteSpace: "pre-wrap", fontSize: "0.85rem", marginTop: "0.5rem" }}>
              {evt.thinking}
            </div>
          </details>
        </Card>
      );
    case "assistant_text":
      return (
        <Card tone="assistant">
          <div style={{ whiteSpace: "pre-wrap" }}>{evt.text}</div>
        </Card>
      );
    case "assistant_tool_use":
      return (
        <Card tone="tool">
          <strong>工具调用：{evt.name}</strong>
          <pre style={{ fontSize: "0.75rem", margin: "0.25rem 0 0", overflow: "auto" }}>
            {JSON.stringify(evt.input, null, 2)}
          </pre>
        </Card>
      );
    case "tool_result":
      return (
        <Card tone="tool">
          <strong>工具结果</strong>
          <pre style={{ fontSize: "0.75rem", margin: "0.25rem 0 0", overflow: "auto" }}>
            {JSON.stringify(evt.content, null, 2)}
          </pre>
        </Card>
      );
    case "result":
      return (
        <Card tone={evt.subtype === "success" ? "success" : "error"}>
          <strong>{evt.subtype === "success" ? "✓ 任务完成" : "× 任务失败"}</strong>
          <div style={{ fontSize: "0.8rem", color: "#666" }}>
            duration={evt.data.durationMs}ms · cost=${evt.data.totalCostUsd.toFixed(6)}
          </div>
        </Card>
      );
    case "unknown":
      return (
        <Card tone="neutral">
          <strong>unknown event</strong>
          <pre style={{ fontSize: "0.75rem", margin: "0.25rem 0 0", overflow: "auto" }}>
            {JSON.stringify(evt.raw, null, 2)}
          </pre>
        </Card>
      );
  }
}

function Card({
  tone,
  children,
}: {
  tone: "neutral" | "warning" | "thinking" | "assistant" | "tool" | "success" | "error";
  children: React.ReactNode;
}): ReactElement {
  const palette: Record<typeof tone, { bg: string; border: string }> = {
    neutral: { bg: "#f3f4f6", border: "#e5e7eb" },
    warning: { bg: "#fef3c7", border: "#fde68a" },
    thinking: { bg: "#f1f5f9", border: "#e2e8f0" },
    assistant: { bg: "#e0f2fe", border: "#bae6fd" },
    tool: { bg: "#ede9fe", border: "#ddd6fe" },
    success: { bg: "#dcfce7", border: "#bbf7d0" },
    error: { bg: "#fee2e2", border: "#fecaca" },
  };
  const c = palette[tone];
  return (
    <div
      style={{
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 6,
        padding: "0.75rem 1rem",
        margin: "0.5rem 0",
      }}
    >
      {children}
    </div>
  );
}
