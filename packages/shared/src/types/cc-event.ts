// CC stream-json 事件的 discriminated union。
// 对应 03-architecture.md §4.2：StreamParser 输出、UI 消费的标准事件形态。

import { z } from "zod";

// MCP server 在 system/init 事件里的信息。字段结构随 CC 版本可能差异，用 passthrough 容错。
export const McpServerInfoSchema = z
  .object({
    name: z.string(),
  })
  .passthrough();

export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;

// system/init 事件携带的完整会话上下文。
export const SystemInitDataSchema = z.object({
  sessionId: z.string(),
  tools: z.array(z.string()),
  mcpServers: z.array(McpServerInfoSchema),
  model: z.string(),
  permissionMode: z.string(),
  claudeCodeVersion: z.string(),
  apiKeySource: z.enum(["subscription", "api_key", "bedrock", "vertex"]),
});

export type SystemInitData = z.infer<typeof SystemInitDataSchema>;

// assistant 事件内部的文本块或思考块。
export const AssistantContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), thinking: z.string() }),
]);

export type AssistantContent = z.infer<typeof AssistantContentSchema>;

// result 事件的 data。字段细节待 Issue #4（stream-parser）结合真实样本细化。
export const ResultDataSchema = z.object({}).passthrough();

export type ResultData = z.infer<typeof ResultDataSchema>;

// rate_limit_event 的 rateLimitInfo。字段同样待 Issue #4 细化。
export const RateLimitInfoSchema = z.object({}).passthrough();

export type RateLimitInfo = z.infer<typeof RateLimitInfoSchema>;

// CC stream-json 全部事件的 discriminated union。
// unknown 变体用于吸收未知 type 的事件（避免因 CC 版本差异而丢数据）。
export const CCEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    data: SystemInitDataSchema,
  }),
  z.object({ type: z.literal("assistant"), content: AssistantContentSchema }),
  z.object({
    type: z.literal("tool_use"),
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("tool_result"),
    toolUseId: z.string(),
    content: z.unknown(),
    isError: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("result"),
    subtype: z.enum(["success", "error"]),
    data: ResultDataSchema,
  }),
  z.object({
    type: z.literal("rate_limit_event"),
    rateLimitInfo: RateLimitInfoSchema,
  }),
  z.object({ type: z.literal("unknown"), raw: z.unknown() }),
]);

export type CCEvent = z.infer<typeof CCEventSchema>;
