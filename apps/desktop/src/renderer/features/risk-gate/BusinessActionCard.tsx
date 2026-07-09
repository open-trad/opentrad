// BusinessActionCard(M1 #28 阶段 3):业务级确认卡片。
//
// 触发条件:skill manifest.stopBefore 命中 toolName,或 tool 显式提供 businessAction。
// 视觉与 RiskGateDialog 相邻但更"业务化":红色警示底,标题"业务操作确认",
// 主文案描述 businessAction 含义(M1 简化:用 businessAction 字符串当文案;M2 加
// tool→business mapping 给更人话描述)。
//
// 4 个按钮同 RiskGateDialog(D-M1-6):allow_once / allow_always / request_edit / deny。

import type { RiskGateConfirmPayload } from "@opentrad/shared";
import { ShieldAlert } from "lucide-react";
import type { ReactElement } from "react";
import { paramsToDisplayString } from "./redact";

export interface BusinessActionCardProps {
  payload: RiskGateConfirmPayload;
  onDecide: (kind: "allow_once" | "allow_always" | "deny" | "request_edit") => void;
}

export function BusinessActionCard({ payload, onDecide }: BusinessActionCardProps): ReactElement {
  // businessAction M1 简化为 toolName 同名字符串(当 stopBeforeList 命中 toolName);
  // tool 自定义 businessAction 时透传。文案在 UI 端格式化:
  const actionLabel = formatBusinessAction(payload.businessAction ?? "(unknown)");
  const paramsDisplay = paramsToDisplayString(payload.params);

  return (
    <div style={overlayStyle}>
      <div style={cardStyle}>
        <header style={headerStyle}>
          <ShieldAlert size={22} aria-hidden="true" />
          <h2 style={{ margin: 0, fontSize: "1.15rem", color: "#7f1d1d" }}>业务操作确认</h2>
        </header>

        <div style={mainCalloutStyle}>
          <strong>{actionLabel}</strong>
          {payload.skillId ? (
            <div style={{ marginTop: "0.35rem", fontSize: "0.85rem", color: "#7f1d1d" }}>
              触发自 skill <code>{payload.skillId}</code>
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: "1rem" }}>
          <span style={paramsLabelStyle}>调用参数(已脱敏)</span>
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

// businessAction 字符串 → UI 友好文案。M1 简化:常见命名直译,未识别的回原值。
// M2 加 i18n + skill manifest 自定义文案。
function formatBusinessAction(action: string): string {
  switch (action) {
    case "send_email":
      return "即将发送邮件";
    case "publish_listing":
      return "即将发布商品 listing";
    case "submit_form":
      return "即将提交表单";
    case "rfq_send":
      return "即将发送 RFQ 询价";
    default:
      return `即将执行业务动作:${action}`;
  }
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

const cardStyle: React.CSSProperties = {
  background: "white",
  borderRadius: 10,
  border: "2px solid #fecaca",
  padding: "1.75rem 2rem",
  maxWidth: 600,
  width: "100%",
  boxShadow: "0 20px 50px rgba(127, 29, 29, 0.25)",
  fontFamily: "system-ui, -apple-system, sans-serif",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
  marginBottom: "1rem",
  color: "#dc2626",
};

const mainCalloutStyle: React.CSSProperties = {
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 6,
  padding: "0.85rem 1rem",
  color: "#7f1d1d",
  fontSize: "1rem",
};

const paramsLabelStyle: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "0.8rem",
  display: "block",
  marginBottom: "0.2rem",
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
  background: "#dc2626",
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
  background: "#7f1d1d",
  color: "white",
  border: "none",
  padding: "0.55rem 1.1rem",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.9rem",
};
