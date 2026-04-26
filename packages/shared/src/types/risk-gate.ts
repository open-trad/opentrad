// Risk Gate 请求/决策数据结构。对应 03-architecture.md §4.5。

import { z } from "zod";

// Risk Gate 拦截时生成的请求（由 OpenTrad MCP server 的 middleware 发起）。
export const RiskGateRequestSchema = z.object({
  skillId: z.string(),
  toolName: z.string(),
  params: z.unknown(),
  riskLevel: z.enum(["safe", "review", "blocked"]),
  businessAction: z.string().optional(), // 命中 skill manifest 的 stop_before 条目
});

export type RiskGateRequest = z.infer<typeof RiskGateRequestSchema>;

// Risk Gate 决策结果（由用户在 UI 弹窗或历史规则产生）。
// timestamp 用 epoch ms，方便写 JSONL 审计日志和按时间查询。
export const RiskGateDecisionSchema = z.object({
  decision: z.enum(["allow", "deny", "allow_once", "allow_always"]),
  reason: z.string().optional(),
  timestamp: z.number().int(),
});

export type RiskGateDecision = z.infer<typeof RiskGateDecisionSchema>;

// -------- M1 #28 renderer ↔ main IPC payload(内部 channel,不走 IPC bridge wire) --------
//
// 通过 IPC channel `risk-gate:confirm` 推 renderer 弹窗;renderer 决策后通过
// `risk-gate:response` 返回。requestId 关联请求-响应对(支持并发多个 prompt)。
//
// **不走 mcp-server ↔ desktop 的 IPC bridge wire**(发起人 #25 hello 帧约束),
// 这是 desktop main ↔ renderer 内部 channel,与 wire 协议解耦。

export const RiskGateConfirmPayloadSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  skillId: z.string().nullable(),
  toolName: z.string(),
  riskLevel: z.enum(["safe", "review", "blocked"]),
  params: z.unknown(),
  // 业务级:非空时 UI 应展示 BusinessActionCard;空时展示 RiskGateDialog 工具级
  businessAction: z.string().nullable(),
  // for UI 展示分组(browser / drafts / utility / platform 等)
  category: z.string().nullable(),
});

export type RiskGateConfirmPayload = z.infer<typeof RiskGateConfirmPayloadSchema>;

export const UserDecisionKindSchema = z.enum([
  "allow_once",
  "allow_always",
  "deny",
  "request_edit",
]);

export const RiskGateResponsePayloadSchema = z.object({
  requestId: z.string(),
  kind: UserDecisionKindSchema,
  // timeout / dismiss 时填 reason
  reason: z.string().optional(),
});

export type RiskGateResponsePayload = z.infer<typeof RiskGateResponsePayloadSchema>;
