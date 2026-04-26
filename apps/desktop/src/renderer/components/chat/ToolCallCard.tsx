// ToolCallCard(M1 #29 12a):assistant_tool_use 事件渲染。
// 参数 JSON 默认折叠,点击展开;紫色主题(对应 M0 简版)。

import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { type ReactElement, useState } from "react";

export interface ToolCallCardProps {
  toolName: string;
  toolUseId: string;
  input: unknown;
}

export function ToolCallCard({ toolName, toolUseId, input }: ToolCallCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false);

  let inputJson = "";
  try {
    inputJson = JSON.stringify(input, null, 2);
  } catch {
    inputJson = "(无法序列化)";
  }

  return (
    <div style={cardStyle}>
      <header style={headerStyle}>
        <Wrench size={14} aria-hidden="true" />
        <code style={codeStyle}>{toolName}</code>
        <span style={idHintStyle}>{toolUseId.slice(0, 8)}…</span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={toggleBtnStyle}
          aria-label={expanded ? "折叠参数" : "展开参数"}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span style={{ marginLeft: "0.2rem" }}>{expanded ? "折叠" : "参数"}</span>
        </button>
      </header>
      {expanded ? <pre style={paramsPreStyle}>{inputJson}</pre> : null}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "#faf5ff",
  border: "1px solid #d8b4fe",
  borderRadius: 8,
  padding: "0.5rem 0.75rem",
  fontSize: "0.85rem",
  color: "#581c87",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
};

const codeStyle: React.CSSProperties = {
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  fontSize: "0.8rem",
  background: "#ede9fe",
  padding: "0.1rem 0.4rem",
  borderRadius: 3,
};

const idHintStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  color: "#a78bfa",
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  marginLeft: "auto",
};

const toggleBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "transparent",
  color: "#7c3aed",
  border: "none",
  padding: "0.1rem 0.3rem",
  cursor: "pointer",
  fontSize: "0.75rem",
  fontFamily: "inherit",
};

const paramsPreStyle: React.CSSProperties = {
  background: "#1e1b4b",
  color: "#e0e7ff",
  padding: "0.6rem",
  borderRadius: 4,
  marginTop: "0.5rem",
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  fontSize: "0.75rem",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  maxHeight: 240,
  overflow: "auto",
};
