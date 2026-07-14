// AgentEvent：provider 无关的统一事件流（重启后新架构的核心事件模型）。
// 由 packages/agent-core 的自建 loop 产生，desktop 渲染与 SQLite 持久化统一消费。
//
// 与旧 CCEvent 的关系（ADR-001）：
// - CCEvent 是 Claude Code stream-json 的 domain 映射，保留给 SubscriptionBackend（cc-adapter 收编）
// - AgentEvent 是自建 loop 的原生事件；SubscriptionBackend 负责 CCEvent → AgentEvent 适配
// - 自建 loop 由我们控制消息边界，无 per-wire-event 的 isLast 歧义：done=true 即"这条消息说完了"

import { z } from "zod";
import { UsageSchema } from "./cc-event";

// 会话开始：模型/工具就绪信息
export const AgentSessionStartEventSchema = z.object({
  type: z.literal("agent_session_start"),
  sessionId: z.string(),
  profileId: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
});

// 助手文本增量（流式）。done=true 表示该条助手消息的文本已完整。
export const AgentTextEventSchema = z.object({
  type: z.literal("agent_text"),
  sessionId: z.string(),
  msgId: z.string(),
  delta: z.string(),
  done: z.boolean(),
});

// 推理/思考增量（支持 reasoning 的模型）
export const AgentThinkingEventSchema = z.object({
  type: z.literal("agent_thinking"),
  sessionId: z.string(),
  msgId: z.string(),
  delta: z.string(),
  done: z.boolean(),
});

// 工具调用请求（loop 已决定调用，尚未执行；Risk Gate 审批发生在执行前）
export const AgentToolCallEventSchema = z.object({
  type: z.literal("agent_tool_call"),
  sessionId: z.string(),
  msgId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
});

// 工具执行结果（含被 Risk Gate 拒绝的情况：denied=true 时 output 为拒绝说明）
export const AgentToolResultEventSchema = z.object({
  type: z.literal("agent_tool_result"),
  sessionId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional(),
  denied: z.boolean().optional(),
});

// 每步 usage 计量（成本可见性是产品承诺，见重启计划"风险与应对"）
export const AgentUsageEventSchema = z.object({
  type: z.literal("agent_usage"),
  sessionId: z.string(),
  msgId: z.string(),
  usage: UsageSchema,
  // 估算成本（USD）；provider 未知定价时为 null
  estimatedCostUsd: z.number().nullable(),
});

// 单轮运行结束（完成 / 预算触顶 / 步数上限 / 用户中止）；不代表对话会话被关闭。
export const AgentSessionResultEventSchema = z.object({
  type: z.literal("agent_session_result"),
  sessionId: z.string(),
  subtype: z.enum(["success", "error", "aborted", "budget_exceeded", "max_steps"]),
  durationMs: z.number().int(),
  numSteps: z.number().int(),
  totalCostUsd: z.number().nullable(),
  errorMessage: z.string().optional(),
});

// 非致命错误（provider 限流、工具执行异常等；致命错误走 session_result subtype=error）
export const AgentErrorEventSchema = z.object({
  type: z.literal("agent_error"),
  sessionId: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
});

export const AgentEventSchema = z.discriminatedUnion("type", [
  AgentSessionStartEventSchema,
  AgentTextEventSchema,
  AgentThinkingEventSchema,
  AgentToolCallEventSchema,
  AgentToolResultEventSchema,
  AgentUsageEventSchema,
  AgentSessionResultEventSchema,
  AgentErrorEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
