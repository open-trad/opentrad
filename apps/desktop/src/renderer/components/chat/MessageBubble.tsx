// MessageBubble(M1 #29 12a):assistant_text / assistant_thinking 渲染。
//
// react-markdown + remark-gfm 支持:
// - 代码块(语法高亮 + 复制按钮)
// - markdown 表格(remark-gfm 自动 → HTML <table>)
// - 链接、列表、标题、引用、粗体斜体、删除线等标准 GFM
//
// thinking 默认折叠(<details>),text 默认展开。

import { Check, Copy } from "lucide-react";
import { type ReactElement, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { atomDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";

export interface MessageBubbleProps {
  kind: "text" | "thinking";
  content: string;
}

export function MessageBubble({ kind, content }: MessageBubbleProps): ReactElement {
  if (kind === "thinking") {
    return (
      <details style={thinkingStyle}>
        <summary style={thinkingSummaryStyle}>思考过程</summary>
        <div style={{ marginTop: "0.5rem" }}>
          <Markdown content={content} />
        </div>
      </details>
    );
  }
  return (
    <div style={textStyle}>
      <Markdown content={content} />
    </div>
  );
}

// markdown 渲染共用组件
function Markdown({ content }: { content: string }): ReactElement {
  return (
    <div style={markdownStyle}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children }) => {
            const match = /language-(\w+)/.exec(className ?? "");
            const text = String(children ?? "").replace(/\n$/, "");
            // inline code(无 language- className 且单行)
            if (!match || !text.includes("\n")) {
              return <code style={inlineCodeStyle}>{children}</code>;
            }
            return <CodeBlock language={match[1] ?? "text"} code={text} />;
          },
          // 表格 wrap 横向滚动 + 浅边框
          table: ({ children }) => (
            <div style={tableWrapperStyle}>
              <table style={tableStyle}>{children}</table>
            </div>
          ),
          th: ({ children }) => <th style={thStyle}>{children}</th>,
          td: ({ children }) => <td style={tdStyle}>{children}</td>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                e.preventDefault();
                if (href) {
                  void window.api.shell
                    .openExternal({ url: href })
                    .catch((err) => console.error("[md] openExternal failed", err));
                }
              }}
              style={linkStyle}
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }): ReactElement {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("[code-block] copy failed", err);
    }
  };

  return (
    <div style={codeBlockWrapperStyle}>
      <header style={codeBlockHeaderStyle}>
        <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>{language}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          style={copyBtnStyle}
          aria-label="复制"
          title="复制"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span style={{ marginLeft: "0.25rem" }}>{copied ? "已复制" : "复制"}</span>
        </button>
      </header>
      <SyntaxHighlighter
        language={language}
        style={atomDark}
        customStyle={{
          margin: 0,
          padding: "0.75rem",
          fontSize: "0.8rem",
          borderRadius: 0,
          borderBottomLeftRadius: 6,
          borderBottomRightRadius: 6,
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

// ----- styles -----

const textStyle: React.CSSProperties = {
  background: "#dbeafe",
  color: "#1e3a8a",
  border: "1px solid #93c5fd",
  borderRadius: 8,
  padding: "0.7rem 0.95rem",
  fontSize: "0.9rem",
};

const thinkingStyle: React.CSSProperties = {
  background: "#f3f4f6",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: "0.6rem 0.85rem",
  fontSize: "0.85rem",
  color: "#475569",
};

const thinkingSummaryStyle: React.CSSProperties = {
  cursor: "pointer",
  fontSize: "0.8rem",
  color: "#6b7280",
};

const markdownStyle: React.CSSProperties = {
  // markdown 元素全局微调:p / h / ul / ol margin 收紧
  lineHeight: 1.5,
};

const inlineCodeStyle: React.CSSProperties = {
  background: "rgba(15, 23, 42, 0.08)",
  padding: "0.1rem 0.3rem",
  borderRadius: 3,
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  fontSize: "0.85em",
};

const codeBlockWrapperStyle: React.CSSProperties = {
  margin: "0.5rem 0",
  borderRadius: 6,
  overflow: "hidden",
  background: "#0f172a",
};

const codeBlockHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "0.35rem 0.6rem",
  background: "#1e293b",
  borderBottom: "1px solid #334155",
};

const copyBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "transparent",
  color: "#cbd5e1",
  border: "1px solid #334155",
  padding: "0.2rem 0.5rem",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: "0.7rem",
  fontFamily: "inherit",
};

const tableWrapperStyle: React.CSSProperties = {
  overflow: "auto",
  marginTop: "0.5rem",
  marginBottom: "0.5rem",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
};

const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  fontSize: "0.85rem",
};

const thStyle: React.CSSProperties = {
  background: "#f8fafc",
  borderBottom: "1px solid #e2e8f0",
  padding: "0.4rem 0.6rem",
  textAlign: "left",
  fontWeight: 600,
  color: "#374151",
};

const tdStyle: React.CSSProperties = {
  borderBottom: "1px solid #f1f5f9",
  padding: "0.4rem 0.6rem",
  color: "#1f2937",
};

const linkStyle: React.CSSProperties = {
  color: "#2563eb",
  textDecoration: "underline",
};
