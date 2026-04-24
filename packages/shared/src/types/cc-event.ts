// CC stream-json 事件的 domain 层：OpenTrad 内部统一消费形态。
// 设计原则（按发起人拍板 D1 = 方案 B'、D6 = 方案 X + D6a 修正）：
// - 字段统一 camelCase
// - assistant event 扁平化为 assistant_text / assistant_thinking / assistant_tool_use 独立变体
// - 同一逻辑消息的多个 domain 事件用 msgId + seq 关联；最后一个带 isLast=true + messageMeta
// - 不泄漏 wire 层字段（snake_case、Anthropic API message 包裹结构等）
// stream-parser 的 normalize 函数负责 wire → domain 映射（含 1→N 扁平化）。

import { z } from "zod";

// ==================== 公共子结构 ====================

// per-message token 消耗（camelCase）
export const UsageSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheCreationInputTokens: z.number().int().optional(),
  cacheReadInputTokens: z.number().int().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

// per-message 元数据，挂在同一 msgId 的最后一个 domain 事件上（D6a）。
export const MessageMetaSchema = z.object({
  model: z.string(),
  usage: UsageSchema,
  stopReason: z.string().nullable().optional(),
});
export type MessageMeta = z.infer<typeof MessageMetaSchema>;

// MCP server info（domain camelCase）
export const McpServerInfoSchema = z.object({
  name: z.string(),
  status: z.string().optional(),
});
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;

// system/init 的 data（normalize 时从 wire 字段挑选 + rename）
export const SystemInitDataSchema = z.object({
  cwd: z.string(),
  sessionId: z.string(),
  tools: z.array(z.string()),
  mcpServers: z.array(McpServerInfoSchema),
  model: z.string(),
  permissionMode: z.string(),
  slashCommands: z.array(z.string()).optional(),
  apiKeySource: z.enum(["subscription", "api_key", "bedrock", "vertex", "none"]),
  claudeCodeVersion: z.string(),
  outputStyle: z.string().optional(),
  agents: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  uuid: z.string(),
});
export type SystemInitData = z.infer<typeof SystemInitDataSchema>;

// rate_limit_event 的 rateLimitInfo。
// 注：wire 层这些字段本身就是 camelCase（CC 原样），domain 层保持一致。
export const RateLimitInfoSchema = z.object({
  status: z.string(),
  resetsAt: z.number().int().optional(),
  rateLimitType: z.string().optional(),
  overageStatus: z.string().optional(),
  overageDisabledReason: z.string().optional(),
  isUsingOverage: z.boolean().optional(),
});
export type RateLimitInfo = z.infer<typeof RateLimitInfoSchema>;

// result 事件的 data：normalize 时从 wire 字段挑选 + camelCase 映射。
// 保留常用字段；modelUsage 等复杂嵌套字段先 unknown 占位，未来需要再收紧。
export const ResultDataSchema = z
  .object({
    durationMs: z.number().int(),
    durationApiMs: z.number().int().optional(),
    numTurns: z.number().int(),
    result: z.string().optional(),
    stopReason: z.string().nullable().optional(),
    totalCostUsd: z.number(),
    isError: z.boolean(),
    terminalReason: z.string().optional(),
    fastModeState: z.string().optional(),
    uuid: z.string(),
    modelUsage: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ResultData = z.infer<typeof ResultDataSchema>;

// ==================== CCEvent discriminated union ====================

// system/init
export const SystemEventSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  data: SystemInitDataSchema,
});

// assistant text block（flatten 自 wire.message.content[i]）
export const AssistantTextEventSchema = z.object({
  type: z.literal("assistant_text"),
  msgId: z.string(),
  seq: z.number().int(),
  sessionId: z.string(),
  uuid: z.string(),
  isLast: z.boolean(),
  messageMeta: MessageMetaSchema.optional(),
  text: z.string(),
});

// assistant thinking block（带 signature）
export const AssistantThinkingEventSchema = z.object({
  type: z.literal("assistant_thinking"),
  msgId: z.string(),
  seq: z.number().int(),
  sessionId: z.string(),
  uuid: z.string(),
  isLast: z.boolean(),
  messageMeta: MessageMetaSchema.optional(),
  thinking: z.string(),
  signature: z.string(),
});

// assistant tool_use block（从 assistant message content 提取）
export const AssistantToolUseEventSchema = z.object({
  type: z.literal("assistant_tool_use"),
  msgId: z.string(),
  seq: z.number().int(),
  sessionId: z.string(),
  uuid: z.string(),
  isLast: z.boolean(),
  messageMeta: MessageMetaSchema.optional(),
  toolUseId: z.string(),
  name: z.string(),
  input: z.unknown(),
});

// tool_result：理论上 wire 源是 user message 的 content block。
// TODO(issue-5): 抓 tool-use fixture 后确认 wire 来源；本 issue 先按 block 结构定义 domain 类型占位。
export const ToolResultEventSchema = z.object({
  type: z.literal("tool_result"),
  msgId: z.string(),
  seq: z.number().int(),
  sessionId: z.string(),
  uuid: z.string(),
  toolUseId: z.string(),
  content: z.unknown(),
  isError: z.boolean().optional(),
});

// result（任务结束）
export const ResultEventSchema = z.object({
  type: z.literal("result"),
  subtype: z.enum(["success", "error"]),
  sessionId: z.string(),
  data: ResultDataSchema,
});

// rate_limit_event
export const RateLimitEventSchema = z.object({
  type: z.literal("rate_limit_event"),
  sessionId: z.string(),
  uuid: z.string(),
  rateLimitInfo: RateLimitInfoSchema,
});

// unknown（兜底未知 type / schema 不匹配的事件，raw 保留原始 JSON 对象或 NDJSON 行字符串）
export const UnknownEventSchema = z.object({
  type: z.literal("unknown"),
  raw: z.unknown(),
});

export const CCEventSchema = z.discriminatedUnion("type", [
  SystemEventSchema,
  AssistantTextEventSchema,
  AssistantThinkingEventSchema,
  AssistantToolUseEventSchema,
  ToolResultEventSchema,
  ResultEventSchema,
  RateLimitEventSchema,
  UnknownEventSchema,
]);
export type CCEvent = z.infer<typeof CCEventSchema>;
