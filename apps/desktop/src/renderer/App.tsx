// App 组件 — M0 阶段：通过 IPC 拿 CC 状态并展示。
// Issue #7 验收点：window.api.cc.status() 能拿到 typed CCStatus，
// 未装/未登录场景 UI 友好提示。

import type { CCStatus } from "@opentrad/shared";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; data: CCStatus }
  | { kind: "error"; message: string };

export function App(): ReactElement {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    window.api.cc
      .status()
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#333",
      }}
    >
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>OpenTrad</h1>
      <CcStatusPanel state={state} />
      <p style={{ color: "#999", fontSize: "0.85rem", marginTop: "2rem" }}>
        M0 骨架 — Issue #7 IPC 通信
      </p>
    </div>
  );
}

function CcStatusPanel({ state }: { state: LoadState }): ReactElement {
  if (state.kind === "loading") {
    return <p style={{ color: "#999" }}>检测 Claude Code...</p>;
  }
  if (state.kind === "error") {
    return (
      <div
        style={{
          color: "#b91c1c",
          background: "#fee2e2",
          padding: "0.75rem 1rem",
          borderRadius: 6,
          maxWidth: 420,
          textAlign: "center",
        }}
      >
        <strong>IPC 调用失败：</strong>
        {state.message}
      </div>
    );
  }
  const s = state.data;
  if (!s.installed) {
    return (
      <div
        style={{
          color: "#92400e",
          background: "#fef3c7",
          padding: "0.75rem 1rem",
          borderRadius: 6,
          maxWidth: 420,
          textAlign: "center",
        }}
      >
        未检测到 Claude Code
        {s.error ? (
          <div style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>{s.error}</div>
        ) : null}
      </div>
    );
  }
  if (!s.loggedIn) {
    return (
      <div style={{ color: "#666", textAlign: "center" }}>
        <div>Claude Code 已安装（v{s.version}）</div>
        <div style={{ color: "#92400e", marginTop: "0.25rem" }}>尚未登录</div>
      </div>
    );
  }
  const methodLabel = s.authMethod === "subscription" ? "Claude 订阅" : "API key";
  return (
    <div style={{ color: "#166534", textAlign: "center" }}>
      <div>
        已登录 <code>{s.email ?? "(unknown)"}</code>（{methodLabel}）
      </div>
      <div style={{ color: "#666", fontSize: "0.85rem", marginTop: "0.25rem" }}>
        Claude Code v{s.version}
      </div>
    </div>
  );
}
