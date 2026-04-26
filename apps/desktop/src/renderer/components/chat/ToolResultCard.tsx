// ToolResultCard(M1 #29 12a):tool_result 事件渲染。
// 长文本默认折叠到前 200 字符,点"展开"看全;isError 红色主题。

import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactElement, useState } from "react";

export interface ToolResultCardProps {
  toolUseId: string;
  // payload 字段名沿 cc-event schema(M0 D6 normalize 后);content 是 array<{type, text}> 或 string
  content: unknown;
  isError?: boolean;
}

const PREVIEW_LENGTH = 200;

export function ToolResultCard({ toolUseId, content, isError }: ToolResultCardProps): ReactElement {
  const [expanded, setExpanded] = useState(false);

  const text = stringifyContent(content);
  const isLong = text.length > PREVIEW_LENGTH;
  const preview = isLong ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;

  return (
    <div style={cardStyle(isError)}>
      <header style={headerStyle}>
        <span style={labelStyle(isError)}>{isError ? "✕ tool error" : "✓ tool result"}</span>
        <span style={idHintStyle}>{toolUseId.slice(0, 8)}…</span>
        {isLong ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={toggleBtnStyle(isError)}
            aria-label={expanded ? "折叠" : "展开"}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span style={{ marginLeft: "0.2rem" }}>{expanded ? "折叠" : "展开"}</span>
          </button>
        ) : null}
      </header>
      <pre style={contentPreStyle}>{expanded || !isLong ? text : preview}</pre>
    </div>
  );
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const obj = item as { type?: string; text?: string };
          if (obj.type === "text" && typeof obj.text === "string") return obj.text;
          return JSON.stringify(item);
        }
        return String(item);
      })
      .join("\n");
  }
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return "(无法序列化)";
    }
  }
  return String(content);
}

const cardStyle = (isError?: boolean): React.CSSProperties => ({
  background: isError ? "#fef2f2" : "#faf5ff",
  border: `1px solid ${isError ? "#fecaca" : "#d8b4fe"}`,
  borderRadius: 8,
  padding: "0.5rem 0.75rem",
  fontSize: "0.85rem",
  color: isError ? "#7f1d1d" : "#581c87",
});

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};

const labelStyle = (isError?: boolean): React.CSSProperties => ({
  fontWeight: 500,
  color: isError ? "#dc2626" : "#7c3aed",
  fontSize: "0.8rem",
});

const idHintStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  color: "#a78bfa",
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  marginLeft: "auto",
};

const toggleBtnStyle = (isError?: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  background: "transparent",
  color: isError ? "#dc2626" : "#7c3aed",
  border: "none",
  padding: "0.1rem 0.3rem",
  cursor: "pointer",
  fontSize: "0.75rem",
  fontFamily: "inherit",
});

const contentPreStyle: React.CSSProperties = {
  background: "#fafafa",
  border: "1px solid #f3f4f6",
  padding: "0.5rem",
  borderRadius: 4,
  marginTop: "0.4rem",
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  fontSize: "0.75rem",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 320,
  overflow: "auto",
  color: "#1f2937",
};
