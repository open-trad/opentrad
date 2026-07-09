// RiskGateDialog(M1 #28 阶段 3):工具级确认弹窗。
//
// 4 个按钮(D-M1-6):
// - 允许一次(allow_once)
// - 以后都允许(allow_always)
// - 拒绝(deny)
// - 编辑后再发(request_edit) — v1 等价 deny + reason='user_requested_edit'
//
// 视觉:中央 modal,标题 "工具调用确认",内容含 toolName / category / 参数(脱敏)。
// 5min 倒计时(由 main 进程控制,UI 仅展示提示,不参与计时);用户不操作也会自动 deny。

import type { RiskGateConfirmPayload } from "@opentrad/shared";
import { AlertTriangle } from "lucide-react";
import type { ReactElement } from "react";
import { paramsToDisplayString } from "./redact";

export interface RiskGateDialogProps {
  payload: RiskGateConfirmPayload;
  onDecide: (kind: "allow_once" | "allow_always" | "deny" | "request_edit") => void;
}

export function RiskGateDialog({ payload, onDecide }: RiskGateDialogProps): ReactElement {
  const paramsDisplay = paramsToDisplayString(payload.params);

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            marginBottom: "1rem",
            color: "#92400e",
          }}
        >
          <AlertTriangle size={20} aria-hidden="true" />
          <h2 style={{ margin: 0, fontSize: "1.15rem", color: "#111827" }}>工具调用确认</h2>
        </header>

        <div style={infoRowStyle}>
          <Label>工具</Label>
          <Value>
            <code style={codeStyle}>{payload.toolName}</code>
            {payload.category ? (
              <span style={{ color: "#6b7280", fontSize: "0.8rem", marginLeft: "0.5rem" }}>
                ({payload.category})
              </span>
            ) : null}
          </Value>
        </div>

        {payload.skillId ? (
          <div style={infoRowStyle}>
            <Label>Skill</Label>
            <Value>
              <code style={codeStyle}>{payload.skillId}</code>
            </Value>
          </div>
        ) : null}

        <div style={{ marginTop: "1rem" }}>
          <Label>参数(已脱敏)</Label>
          <pre style={paramsBlockStyle}>{paramsDisplay}</pre>
        </div>

        <p style={timeoutHintStyle}>5 分钟内不操作将自动拒绝。</p>

        <footer style={buttonRowStyle}>
          <button type="button" onClick={() => onDecide("allow_once")} style={primaryBtn}>
            允许一次
          </button>
          <button type="button" onClick={() => onDecide("allow_always")} style={secondaryBtn}>
            以后都允许
          </button>
          <button type="button" onClick={() => onDecide("request_edit")} style={secondaryBtn}>
            编辑后再发
          </button>
          <button type="button" onClick={() => onDecide("deny")} style={denyBtn}>
            拒绝
          </button>
        </footer>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <span
      style={{ color: "#6b7280", fontSize: "0.8rem", display: "block", marginBottom: "0.2rem" }}
    >
      {children}
    </span>
  );
}

function Value({ children }: { children: React.ReactNode }): ReactElement {
  return <div style={{ color: "#111827", fontSize: "0.9rem" }}>{children}</div>;
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "2rem",
  zIndex: 9999,
};

const modalStyle: React.CSSProperties = {
  background: "white",
  borderRadius: 10,
  padding: "1.75rem 2rem",
  maxWidth: 600,
  width: "100%",
  boxShadow: "0 20px 50px rgba(0, 0, 0, 0.25)",
  fontFamily: "system-ui, -apple-system, sans-serif",
};

const infoRowStyle: React.CSSProperties = {
  marginBottom: "0.75rem",
};

const codeStyle: React.CSSProperties = {
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  fontSize: "0.85rem",
  background: "#f3f4f6",
  padding: "0.15rem 0.4rem",
  borderRadius: 4,
};

const paramsBlockStyle: React.CSSProperties = {
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  padding: "0.75rem",
  marginTop: "0.4rem",
  marginBottom: "0",
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  fontSize: "0.8rem",
  maxHeight: 220,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  color: "#374151",
};

const timeoutHintStyle: React.CSSProperties = {
  marginTop: "1rem",
  marginBottom: "1.25rem",
  fontSize: "0.75rem",
  color: "#9ca3af",
};

const buttonRowStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.6rem",
  flexWrap: "wrap",
  justifyContent: "flex-end",
};

const primaryBtn: React.CSSProperties = {
  background: "#2563eb",
  color: "white",
  border: "none",
  padding: "0.55rem 1.1rem",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.9rem",
};

const secondaryBtn: React.CSSProperties = {
  background: "white",
  color: "#374151",
  border: "1px solid #d1d5db",
  padding: "0.55rem 1.1rem",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.9rem",
};

const denyBtn: React.CSSProperties = {
  background: "white",
  color: "#b91c1c",
  border: "1px solid #fca5a5",
  padding: "0.55rem 1.1rem",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.9rem",
};
