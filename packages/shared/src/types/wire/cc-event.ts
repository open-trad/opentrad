// CC stream-json wire 层：CC 原始 NDJSON 事件的保真 schema。
// 设计原则（按发起人拍板 D1 = 方案 B'）：
// - 字段命名与 CC 原样一致（主体 snake_case，局部 camelCase 如 apiKeySource / permissionMode）
// - 每个 object schema 加 .passthrough() 兜底未来 CC 版本新增字段
// - 所有类型带 Wire 前缀；绝不泄漏到 domain 层
// - stream-parser 的 normalize 函数负责 wire → domain 显式映射（含扁平化）

import { z } from "zod";

// ==================== 子结构 ====================

export const WireMcpServerInfoSchema = z
  .object({
    name: z.string(),
    status: z.string().optional(),
  })
  .passthrough();
export type WireMcpServerInfo = z.infer<typeof WireMcpServerInfoSchema>;

// assistant message 的 usage 块（Anthropic API 格式）。字段命名混杂但保真。
export const WireUsageSchema = z
  .object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    cache_creation_input_tokens: z.number().int().optional(),
    cache_read_input_tokens: z.number().int().optional(),
    cache_creation: z
      .object({
        ephemeral_5m_input_tokens: z.number().int().optional(),
        ephemeral_1h_input_tokens: z.number().int().optional(),
      })
      .passthrough()
      .optional(),
    service_tier: z.string().optional(),
    inference_geo: z.string().optional(),
  })
  .passthrough();
export type WireUsage = z.infer<typeof WireUsageSchema>;

// rate_limit_event 的 rate_limit_info 块。
// 注意：外层 key 是 snake_case (rate_limit_info)，内层字段是 camelCase (resetsAt 等)。CC 混合风格，保真。
export const WireRateLimitInfoSchema = z
  .object({
    status: z.string(),
    resetsAt: z.number().int().optional(),
    rateLimitType: z.string().optional(),
    overageStatus: z.string().optional(),
    overageDisabledReason: z.string().optional(),
    isUsingOverage: z.boolean().optional(),
  })
  .passthrough();
export type WireRateLimitInfo = z.infer<typeof WireRateLimitInfoSchema>;

// ==================== assistant message 的 content block 类型 ====================
// Anthropic API 规范：content 是 block 数组，每个 block 按 type 区分。

export const WireTextContentBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough();

export const WireThinkingContentBlockSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string(),
  })
  .passthrough();

export const WireToolUseContentBlockSchema = z
  .object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  })
  .passthrough();

// tool_result 在 Anthropic API 规范里属于 user message 的 content block。
// TODO(issue-5): 抓真实 tool-use fixture 后确认 CC wire 发法——是独立 user event 还是嵌入 assistant message。
export const WireToolResultContentBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

export const WireContentBlockSchema = z.discriminatedUnion("type", [
  WireTextContentBlockSchema,
  WireThinkingContentBlockSchema,
  WireToolUseContentBlockSchema,
  WireToolResultContentBlockSchema,
]);
export type WireContentBlock = z.infer<typeof WireContentBlockSchema>;

// assistant event 携带的 Anthropic API message 对象
export const WireAssistantMessageSchema = z
  .object({
    id: z.string(),
    type: z.literal("message"),
    role: z.literal("assistant"),
    model: z.string(),
    content: z.array(WireContentBlockSchema),
    stop_reason: z.string().nullable().optional(),
    stop_sequence: z.string().nullable().optional(),
    stop_details: z.unknown().optional(),
    usage: WireUsageSchema,
    context_management: z.unknown().optional(),
  })
  .passthrough();
export type WireAssistantMessage = z.infer<typeof WireAssistantMessageSchema>;

// ==================== top-level wire events ====================

// system/init event
export const WireSystemInitEventSchema = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    cwd: z.string(),
    session_id: z.string(),
    tools: z.array(z.string()),
    mcp_servers: z.array(WireMcpServerInfoSchema),
    model: z.string(),
    permissionMode: z.string(),
    slash_commands: z.array(z.string()).optional(),
    apiKeySource: z.enum(["subscription", "api_key", "bedrock", "vertex", "none"]),
    claude_code_version: z.string(),
    output_style: z.string().optional(),
    agents: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    plugins: z.array(z.unknown()).optional(),
    analytics_disabled: z.boolean().optional(),
    uuid: z.string(),
    memory_paths: z.record(z.string(), z.string()).optional(),
    fast_mode_state: z.string().optional(),
  })
  .passthrough();
export type WireSystemInitEvent = z.infer<typeof WireSystemInitEventSchema>;

// assistant event
export const WireAssistantEventSchema = z
  .object({
    type: z.literal("assistant"),
    message: WireAssistantMessageSchema,
    parent_tool_use_id: z.string().nullable().optional(),
    session_id: z.string(),
    uuid: z.string(),
  })
  .passthrough();
export type WireAssistantEvent = z.infer<typeof WireAssistantEventSchema>;

// rate_limit_event
export const WireRateLimitEventSchema = z
  .object({
    type: z.literal("rate_limit_event"),
    rate_limit_info: WireRateLimitInfoSchema,
    uuid: z.string(),
    session_id: z.string(),
  })
  .passthrough();
export type WireRateLimitEvent = z.infer<typeof WireRateLimitEventSchema>;

// result event（任务结束）
// modelUsage 是 map<model_name, usage>；permission_denials 结构暂 unknown。
export const WireResultEventSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.enum(["success", "error"]),
    is_error: z.boolean(),
    api_error_status: z.unknown().nullable().optional(),
    duration_ms: z.number().int(),
    duration_api_ms: z.number().int().optional(),
    num_turns: z.number().int(),
    result: z.string().optional(),
    stop_reason: z.string().nullable().optional(),
    session_id: z.string(),
    total_cost_usd: z.number(),
    usage: z.unknown().optional(),
    modelUsage: z.record(z.string(), z.unknown()).optional(),
    permission_denials: z.array(z.unknown()).optional(),
    terminal_reason: z.string().optional(),
    fast_mode_state: z.string().optional(),
    uuid: z.string(),
  })
  .passthrough();
export type WireResultEvent = z.infer<typeof WireResultEventSchema>;

// ==================== wire CCEvent discriminated union ====================

export const WireCCEventSchema = z.discriminatedUnion("type", [
  WireSystemInitEventSchema,
  WireAssistantEventSchema,
  WireRateLimitEventSchema,
  WireResultEventSchema,
]);
export type WireCCEvent = z.infer<typeof WireCCEventSchema>;
