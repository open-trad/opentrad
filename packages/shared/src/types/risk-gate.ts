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
