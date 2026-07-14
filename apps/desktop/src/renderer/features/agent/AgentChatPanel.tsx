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
import type { HermesRuntimeInstallProgress } from "@opentrad/shared";
import { Bot, RefreshCw, Send, Square } from "lucide-react";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { MessageBubble } from "../../components/chat/MessageBubble";
import { ToolCallCard } from "../../components/chat/ToolCallCard";
import { ToolResultCard } from "../../components/chat/ToolResultCard";
import {
  type AgentChatItem,
  type AgentConversationContinuation,
  useAgentStore,
} from "../../stores/agent";

export function agentConversationComposerState(continuation: AgentConversationContinuation): {
  disabled: boolean;
  placeholder: string;
  action: "send" | "recovering" | "retry" | "historical";
} {
  switch (continuation) {
    case "ready":
      return { disabled: false, placeholder: "输入消息，Enter 发送", action: "send" };
    case "recovering":
      return { disabled: true, placeholder: "正在恢复会话…", action: "recovering" };
    case "retryable":
      return { disabled: true, placeholder: "会话暂时断开，请重试恢复", action: "retry" };
    case "historical":
      return {
        disabled: true,
        placeholder: "这条旧记录缺少可恢复的运行时会话",
        action: "historical",
      };
  }
}

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
  const runtimeInstallProgress = useAgentStore((s) => s.runtimeInstallProgress);
  const [profileId, setProfileId] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [starting, setStarting] = useState(false);

  const effectiveProfileId = profileId || profiles[0]?.id || "";
  const selectedProfile = profiles.find((profile) => profile.id === effectiveProfileId);

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
          <h2 style={{ margin: 0, fontSize: "1.05rem", color: "#111827" }}>Hermes Agent</h2>
        </div>
        <p style={{ margin: "0.4rem 0 1rem", fontSize: "0.82rem", color: "#6b7280" }}>
          Hermes 原生会话、恢复、tools、skills 与 plugins；OpenTrad 负责工作区验证、审批和审计。
          Profile 在设置 → Providers 里管理。
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
            {selectedProfile ? <HermesExecutionBackendNotice profile={selectedProfile} /> : null}
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
            {starting && runtimeInstallProgress ? (
              <HermesRuntimeInstallProgressNotice progress={runtimeInstallProgress} />
            ) : null}
          </>
        )}
        {error ? <div style={errorLineStyle}>{error}</div> : null}
      </div>
    </div>
  );
}

type HermesRuntimeInstallArtifact = Extract<
  HermesRuntimeInstallProgress,
  { artifact: string }
>["artifact"];

const RUNTIME_INSTALL_PHASE_LABELS: Record<HermesRuntimeInstallProgress["phase"], string> = {
  checking: "正在检查运行时",
  downloading: "正在下载",
  "verifying-download": "正在校验下载",
  preparing: "正在准备运行时",
  installing: "正在安装 Hermes",
  "verifying-runtime": "正在校验运行时",
  switching: "正在激活运行时",
  ready: "Hermes 运行时已就绪",
};

const RUNTIME_INSTALL_ARTIFACT_LABELS: Record<HermesRuntimeInstallArtifact, string> = {
  cpython: "CPython 3.12",
  uv: "uv",
  "hermes-wheel": "Hermes wheel",
  "requirements-lock": "固定依赖",
  "hermes-source": "Hermes 内建 skills",
};

export function HermesRuntimeInstallProgressNotice({
  progress,
}: {
  progress: HermesRuntimeInstallProgress;
}): ReactElement {
  const artifact =
    "artifact" in progress ? RUNTIME_INSTALL_ARTIFACT_LABELS[progress.artifact] : null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-runtime-install-phase={progress.phase}
      style={runtimeInstallProgressStyle}
    >
      <strong>受管 Hermes 运行时</strong>
      <span>
        {RUNTIME_INSTALL_PHASE_LABELS[progress.phase]}
        {artifact ? ` · ${artifact}` : ""}
      </span>
    </div>
  );
}

// ----- 对话视图 -----

function ChatView(): ReactElement {
  const items = useAgentStore((s) => s.items);
  const running = useAgentStore((s) => s.running);
  const continuation = useAgentStore((s) => s.continuation);
  const sessionModel = useAgentStore((s) => s.sessionModel);
  const sessionTools = useAgentStore((s) => s.sessionTools);
  const totalCostUsd = useAgentStore((s) => s.totalCostUsd);
  const error = useAgentStore((s) => s.error);
  const sendMessage = useAgentStore((s) => s.sendMessage);
  const retrySession = useAgentStore((s) => s.retrySession);
  const abort = useAgentStore((s) => s.abort);
  const resetSession = useAgentStore((s) => s.resetSession);
  const profiles = useAgentStore((s) => s.profiles);
  const sessionProfileId = useAgentStore((s) => s.sessionProfileId);
  const workspaceRoot = useAgentStore((s) => s.workspaceRoot);
  const sessionProfile = profiles.find((profile) => profile.id === sessionProfileId);
  const composer = agentConversationComposerState(continuation);

  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // 新事件到达时滚到底
  // biome-ignore lint/correctness/useExhaustiveDependencies: items.length 变化即触发滚动
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length]);

  const handleSend = (): void => {
    const text = draft.trim();
    if (!text || running || composer.disabled) return;
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
          新建任务
        </button>
      </header>

      {sessionProfile ? (
        <HermesExecutionBackendNotice profile={sessionProfile} workspaceRoot={workspaceRoot} />
      ) : null}

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
          placeholder={composer.placeholder}
          disabled={composer.disabled}
          rows={2}
          style={textareaStyle}
        />
        {running ? (
          <button type="button" onClick={() => void abort()} style={abortBtnStyle} title="中止">
            <Square size={14} />
            <span style={{ marginLeft: "0.3rem" }}>中止</span>
          </button>
        ) : composer.action === "retry" ? (
          <button
            type="button"
            onClick={() => void retrySession()}
            style={primaryBtnStyle}
            title="重试恢复会话"
          >
            <RefreshCw size={14} />
            <span style={{ marginLeft: "0.3rem" }}>重试恢复</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={composer.disabled || draft.trim().length === 0}
            style={{
              ...primaryBtnStyle,
              opacity: composer.disabled || !draft.trim() ? 0.5 : 1,
            }}
            title={composer.action === "recovering" ? "正在恢复" : "发送"}
          >
            <Send size={14} />
            <span style={{ marginLeft: "0.3rem" }}>
              {composer.action === "recovering"
                ? "恢复中"
                : composer.action === "historical"
                  ? "历史记录"
                  : "发送"}
            </span>
          </button>
        )}
      </footer>
    </div>
  );
}

export function HermesExecutionBackendNotice({
  profile,
  workspaceRoot,
}: {
  profile: ProviderProfile;
  workspaceRoot?: string | null;
}): ReactElement {
  const pluginWarning = "Hermes plugins 会作为受信代码运行，安装前请确认来源。";
  if (profile.hermes.executionBackend === "docker") {
    return (
      <div style={executionNoticeStyle} data-execution-backend="docker">
        <strong>Docker 隔离（按需启动）</strong>
        <span>
          {workspaceRoot
            ? `已选择 ${workspaceRoot}，仅映射到容器 /workspace。`
            : "创建会话时选择的 workspace 将单独映射到容器 /workspace。"}
          容器按 workspace 分片，工具操作仍走手动审批。{pluginWarning}
        </span>
      </div>
    );
  }
  return (
    <div style={executionNoticeStyle} data-execution-backend="local">
      <strong>本地执行</strong>
      <span>
        Hermes 与当前 macOS 用户相同权限；文件、进程和网络操作仍走手动审批。{pluginWarning}
      </span>
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

const executionNoticeStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.2rem",
  margin: "0 0 0.9rem",
  padding: "0.55rem 0.65rem",
  border: "1px solid #fde68a",
  borderRadius: 6,
  background: "#fffbeb",
  color: "#78350f",
  fontSize: "0.75rem",
  lineHeight: 1.45,
  overflowWrap: "anywhere",
};

const runtimeInstallProgressStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
  marginTop: "0.7rem",
  padding: "0.55rem 0.65rem",
  border: "1px solid #bfdbfe",
  borderRadius: 6,
  background: "#eff6ff",
  color: "#1e3a8a",
  fontSize: "0.78rem",
  lineHeight: 1.4,
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
