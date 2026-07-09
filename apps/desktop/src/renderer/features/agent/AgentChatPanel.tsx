// AgentChatPanel（M0 spike）：自建 agent loop 的最小对话界面。
//
// - 会话前：选 Profile + 可选 bb-browser 等 MCP server 命令行 → 新建会话
// - 会话中：AgentChatItem 流渲染——复用现有 Chat 组件（MessageBubble / ToolCallCard /
//   ToolResultCard），usage 成本行与 result 状态行为 agent 专属轻量样式
// - denied 工具结果：红色卡片 + "Risk Gate 已拒绝" 标记（审批弹窗本身复用全局
//   RiskGateOverlay，无需本组件做任何事）
//
// Profile 管理入口在 Settings → Providers（ProvidersTab）。

import type { ProviderProfile } from "@opentrad/model-providers";
import { Bot, Send, Square } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { MessageBubble } from "../../components/chat/MessageBubble";
import { ToolCallCard } from "../../components/chat/ToolCallCard";
import { ToolResultCard } from "../../components/chat/ToolResultCard";
import { type AgentChatItem, useAgentStore } from "../../stores/agent";

export function AgentChatPanel(): ReactElement {
  const sessionId = useAgentStore((s) => s.sessionId);
  const profiles = useAgentStore((s) => s.profiles);
  const profilesLoaded = useAgentStore((s) => s.profilesLoaded);
  const error = useAgentStore((s) => s.error);
  const loadProfiles = useAgentStore((s) => s.loadProfiles);

  useEffect(() => {
    if (!profilesLoaded) void loadProfiles();
  }, [profilesLoaded, loadProfiles]);

  if (!sessionId) {
    return <SessionSetup profiles={profiles} error={error} />;
  }
  return <ChatView />;
}

// ----- 会话创建表单 -----

function SessionSetup({
  profiles,
  error,
}: {
  profiles: ProviderProfile[];
  error: string | null;
}): ReactElement {
  const startSession = useAgentStore((s) => s.startSession);
  const [profileId, setProfileId] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [starting, setStarting] = useState(false);

  const effectiveProfileId = profileId || profiles[0]?.id || "";

  const handleStart = async (): Promise<void> => {
    if (!effectiveProfileId) return;
    setStarting(true);
    try {
      // MCP 命令行按空白切分：首段 command 余下 args；命名空间固定 bb（M0 spike 单 server）
      const trimmed = mcpCommand.trim();
      const mcpServers = trimmed
        ? [
            {
              name: "bb",
              command: trimmed.split(/\s+/)[0] ?? "",
              args: trimmed.split(/\s+/).slice(1),
            },
          ]
        : [];
      await startSession({ profileId: effectiveProfileId, mcpServers });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div style={setupWrapStyle}>
      <div style={setupCardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <Bot size={18} aria-hidden="true" />
          <h2 style={{ margin: 0, fontSize: "1.05rem", color: "#111827" }}>
            Agent 对话（M0 spike）
          </h2>
        </div>
        <p style={{ margin: "0.4rem 0 1rem", fontSize: "0.82rem", color: "#6b7280" }}>
          自建 agent loop：纯 API key 直连，工具调用统一过 Risk Gate。Profile 在设置 → Providers
          里管理。
        </p>

        {profiles.length === 0 ? (
          <div style={setupEmptyStyle}>
            还没有 Provider Profile。先到 设置 → Providers 添加（DeepSeek / Anthropic 等）。
          </div>
        ) : (
          <>
            <label style={fieldLabelStyle}>
              Profile
              <select
                value={effectiveProfileId}
                onChange={(e) => setProfileId(e.target.value)}
                style={setupSelectStyle}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}（{p.kind} · {p.model}）
                  </option>
                ))}
              </select>
            </label>
            <label style={fieldLabelStyle}>
              MCP server 命令（可选，如 bb-browser）
              <input
                type="text"
                value={mcpCommand}
                onChange={(e) => setMcpCommand(e.target.value)}
                placeholder="npx bb-browser-mcp（留空 = 不挂工具）"
                style={setupInputStyle}
              />
            </label>
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={starting || !effectiveProfileId}
              style={{ ...primaryBtnStyle, opacity: starting ? 0.6 : 1 }}
            >
              {starting ? "创建中…" : "新建会话"}
            </button>
          </>
        )}
        {error ? <div style={errorLineStyle}>{error}</div> : null}
      </div>
    </div>
  );
}

// ----- 对话视图 -----

function ChatView(): ReactElement {
  const items = useAgentStore((s) => s.items);
  const running = useAgentStore((s) => s.running);
  const ended = useAgentStore((s) => s.ended);
  const sessionModel = useAgentStore((s) => s.sessionModel);
  const sessionTools = useAgentStore((s) => s.sessionTools);
  const totalCostUsd = useAgentStore((s) => s.totalCostUsd);
  const error = useAgentStore((s) => s.error);
  const sendMessage = useAgentStore((s) => s.sendMessage);
  const abort = useAgentStore((s) => s.abort);
  const resetSession = useAgentStore((s) => s.resetSession);

  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 新事件到达时滚到底
  // biome-ignore lint/correctness/useExhaustiveDependencies: items.length 变化即触发滚动
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length]);

  const handleSend = (): void => {
    const text = draft.trim();
    if (!text || running || ended) return;
    setDraft("");
    void sendMessage(text);
  };

  return (
    <div style={chatWrapStyle}>
      <header style={chatHeaderStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
          <Bot size={15} aria-hidden="true" />
          <span style={{ fontSize: "0.82rem", color: "#374151" }}>
            {sessionModel ?? "…"} · 工具 {sessionTools.length} 个
          </span>
          {totalCostUsd != null ? (
            <span style={{ fontSize: "0.78rem", color: "#6b7280" }}>
              · 累计 ${totalCostUsd.toFixed(4)}
            </span>
          ) : null}
        </div>
        <button type="button" onClick={resetSession} style={secondaryBtnStyle}>
          结束并新建
        </button>
      </header>

      <div style={chatScrollStyle}>
        {items.length === 0 ? (
          <div style={{ color: "#9ca3af", padding: "2rem 0", fontSize: "0.9rem" }}>
            会话就绪，输入第一条消息开始。
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {items.map((item, i) => (
              <ChatItemCard
                // biome-ignore lint/suspicious/noArrayIndexKey: items 顺序追加,index 即唯一稳定 key
                key={i}
                item={item}
              />
            ))}
          </div>
        )}
        {error ? <div style={errorLineStyle}>{error}</div> : null}
        <div ref={bottomRef} />
      </div>

      <footer style={chatInputBarStyle}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={ended ? "会话已结束（结束并新建以继续）" : "输入消息，Enter 发送"}
          disabled={ended}
          rows={2}
          style={textareaStyle}
        />
        {running ? (
          <button type="button" onClick={() => void abort()} style={abortBtnStyle} title="中止">
            <Square size={14} />
            <span style={{ marginLeft: "0.3rem" }}>中止</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={ended || draft.trim().length === 0}
            style={{ ...primaryBtnStyle, opacity: ended || !draft.trim() ? 0.5 : 1 }}
            title="发送"
          >
            <Send size={14} />
            <span style={{ marginLeft: "0.3rem" }}>发送</span>
          </button>
        )}
      </footer>
    </div>
  );
}

function ChatItemCard({ item }: { item: AgentChatItem }): ReactElement | null {
  switch (item.kind) {
    case "user":
      return <div style={userBubbleStyle}>{item.text}</div>;
    case "text":
      return <MessageBubble kind="text" content={item.content} />;
    case "thinking":
      return <MessageBubble kind="thinking" content={item.content} />;
    case "tool_call":
      return (
        <ToolCallCard toolName={item.toolName} toolUseId={item.toolCallId} input={item.input} />
      );
    case "tool_result":
      if (item.denied) {
        // denied 专属卡片：Risk Gate 拒绝走的是"错误结果喂回模型自愈"路径
        return (
          <div style={deniedCardStyle}>
            <strong style={{ fontSize: "0.8rem" }}>⛔ Risk Gate 已拒绝</strong>
            <code style={deniedCodeStyle}>{item.toolName}</code>
            <div style={{ fontSize: "0.78rem", marginTop: "0.3rem", color: "#7f1d1d" }}>
              {String(item.output)}
            </div>
          </div>
        );
      }
      return (
        <ToolResultCard toolUseId={item.toolCallId} content={item.output} isError={item.isError} />
      );
    case "usage":
      return (
        <div style={usageLineStyle}>
          tokens {item.inputTokens}↑ / {item.outputTokens}↓
          {item.estimatedCostUsd != null
            ? ` · ≈$${item.estimatedCostUsd.toFixed(6)}`
            : " · 定价未知"}
        </div>
      );
    case "result":
      return <ResultLine item={item} />;
    case "error":
      return <div style={errorLineStyle}>⚠ {item.message}</div>;
    default:
      return null;
  }
}

function ResultLine({ item }: { item: Extract<AgentChatItem, { kind: "result" }> }): ReactElement {
  const label: Record<string, string> = {
    success: "✓ 本轮完成",
    error: "× 出错",
    aborted: "■ 已中止",
    budget_exceeded: "¥ 预算触顶",
    max_steps: "↯ 步数上限",
  };
  const ok = item.subtype === "success";
  return (
    <div
      style={{
        fontSize: "0.8rem",
        color: ok ? "#166534" : "#b91c1c",
        padding: "0.3rem 0.1rem",
      }}
    >
      {label[item.subtype] ?? item.subtype} · {item.numSteps} 步
      {item.totalCostUsd != null ? ` · 累计 $${item.totalCostUsd.toFixed(4)}` : ""}
      {item.errorMessage ? ` · ${item.errorMessage}` : ""}
    </div>
  );
}

// ----- styles -----

const setupWrapStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#fff",
  overflowY: "auto",
};

const setupCardStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 480,
  padding: "1.5rem",
  border: "1px solid #e5e7eb",
  borderRadius: 10,
  background: "#fff",
};

const setupEmptyStyle: React.CSSProperties = {
  padding: "1rem",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  borderRadius: 8,
  color: "#92400e",
  fontSize: "0.85rem",
};

const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "0.8rem",
  color: "#374151",
  marginBottom: "0.9rem",
};

const setupSelectStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: "0.3rem",
  padding: "0.45rem 0.6rem",
  fontSize: "0.85rem",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  background: "white",
  fontFamily: "inherit",
};

const setupInputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: "0.3rem",
  padding: "0.45rem 0.6rem",
  fontSize: "0.85rem",
  border: "1px solid #d1d5db",
  borderRadius: 6,
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  boxSizing: "border-box",
};

const primaryBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "#2563eb",
  color: "white",
  border: "none",
  padding: "0.5rem 1rem",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.85rem",
  fontFamily: "inherit",
};

const secondaryBtnStyle: React.CSSProperties = {
  background: "white",
  color: "#475569",
  border: "1px solid #e5e7eb",
  padding: "0.3rem 0.7rem",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.78rem",
  fontFamily: "inherit",
};

const abortBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "#dc2626",
  color: "white",
  border: "none",
  padding: "0.5rem 1rem",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: "0.85rem",
  fontFamily: "inherit",
};

const chatWrapStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  background: "#fff",
  minHeight: 0,
};

const chatHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "0.6rem 1rem",
  borderBottom: "1px solid #e5e7eb",
  flexShrink: 0,
};

const chatScrollStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "1rem",
};

const chatInputBarStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "flex-end",
  padding: "0.75rem 1rem",
  borderTop: "1px solid #e5e7eb",
  flexShrink: 0,
};

const textareaStyle: React.CSSProperties = {
  flex: 1,
  resize: "none",
  padding: "0.5rem 0.7rem",
  fontSize: "0.9rem",
  border: "1px solid #d1d5db",
  borderRadius: 8,
  fontFamily: "inherit",
  lineHeight: 1.4,
};

const userBubbleStyle: React.CSSProperties = {
  alignSelf: "flex-end",
  maxWidth: "85%",
  background: "#f1f5f9",
  color: "#0f172a",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  padding: "0.6rem 0.9rem",
  fontSize: "0.9rem",
  whiteSpace: "pre-wrap",
};

const usageLineStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  color: "#94a3b8",
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  padding: "0 0.1rem",
};

const deniedCardStyle: React.CSSProperties = {
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 8,
  padding: "0.5rem 0.75rem",
  color: "#b91c1c",
};

const deniedCodeStyle: React.CSSProperties = {
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  fontSize: "0.78rem",
  background: "#fee2e2",
  padding: "0.1rem 0.4rem",
  borderRadius: 3,
  marginLeft: "0.4rem",
};

const errorLineStyle: React.CSSProperties = {
  marginTop: "0.6rem",
  fontSize: "0.8rem",
  color: "#b91c1c",
};
