// SQLite row 的 domain 层类型（按 D1 wire/domain 两层规范）。
// 设计原则：
// - SQLite 列名 snake_case（schema 在 apps/desktop/src/main/services/db/schema.ts）
// - 本文件的 domain 类型全部 camelCase
// - INTEGER 0/1 → boolean 在 service 层转换
// - TEXT JSON 字符串 → 任意 unknown value 在 service 层转换
// 表对应：03-architecture.md §五 SQLite Schema。

import { z } from "zod";

// ==================== sessions ====================

export const SessionStatusSchema = z.enum(["active", "completed", "cancelled", "error"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionRowSchema = z.object({
  id: z.string(), // UUID
  title: z.string(),
  skillId: z.string().nullable(),
  ccSessionPath: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastModel: z.string().nullable(),
  totalCostUsd: z.number(),
  messageCount: z.number().int(),
  status: SessionStatusSchema,
});
export type SessionRow = z.infer<typeof SessionRowSchema>;

// 创建 session 时不需要传所有字段（id / created_at / updated_at 等由 service 生成或由调用方传）
export const SessionCreateInputSchema = z.object({
  id: z.string(),
  title: z.string(),
  skillId: z.string().nullable().optional(),
  ccSessionPath: z.string().nullable().optional(),
  status: SessionStatusSchema.default("active"),
});
export type SessionCreateInput = z.infer<typeof SessionCreateInputSchema>;

// ==================== events ====================

export const EventRowSchema = z.object({
  id: z.number().int(),
  sessionId: z.string(),
  seq: z.number().int(),
  type: z.string(),
  payload: z.string(), // JSON string
  timestamp: z.number().int(),
});
export type EventRow = z.infer<typeof EventRowSchema>;

export const EventAppendInputSchema = z.object({
  sessionId: z.string(),
  seq: z.number().int(),
  type: z.string(),
  payload: z.unknown(), // service 层负责 JSON.stringify
  timestamp: z.number().int().optional(), // 默认 Date.now()
});
export type EventAppendInput = z.infer<typeof EventAppendInputSchema>;

// ==================== risk_rules ====================

export const RiskRuleDecisionSchema = z.enum(["allow", "deny"]);
export type RiskRuleDecision = z.infer<typeof RiskRuleDecisionSchema>;

export const RiskRuleRowSchema = z.object({
  id: z.number().int(),
  skillId: z.string().nullable(),
  toolName: z.string().nullable(),
  businessAction: z.string().nullable(),
  decision: RiskRuleDecisionSchema,
  createdAt: z.number().int(),
});
export type RiskRuleRow = z.infer<typeof RiskRuleRowSchema>;

export const RiskRuleSaveInputSchema = z.object({
  skillId: z.string().nullable().optional(),
  toolName: z.string().nullable().optional(),
  businessAction: z.string().nullable().optional(),
  decision: RiskRuleDecisionSchema,
});
export type RiskRuleSaveInput = z.infer<typeof RiskRuleSaveInputSchema>;

export const RiskRuleMatchQuerySchema = z.object({
  skillId: z.string().nullable().optional(),
  toolName: z.string().nullable().optional(),
  businessAction: z.string().nullable().optional(),
});
export type RiskRuleMatchQuery = z.infer<typeof RiskRuleMatchQuerySchema>;

// ==================== audit_log ====================

export const AuditLogRowSchema = z.object({
  id: z.number().int(),
  timestamp: z.number().int(),
  sessionId: z.string(),
  skillId: z.string().nullable(),
  toolName: z.string(),
  businessAction: z.string().nullable(),
  paramsJson: z.string().nullable(),
  decision: z.string(),
  automated: z.boolean(), // 0/1 → boolean
  reason: z.string().nullable(),
});
export type AuditLogRow = z.infer<typeof AuditLogRowSchema>;

export const AuditLogAppendInputSchema = z.object({
  sessionId: z.string(),
  skillId: z.string().nullable().optional(),
  toolName: z.string(),
  businessAction: z.string().nullable().optional(),
  paramsJson: z.string().nullable().optional(),
  decision: z.string(),
  automated: z.boolean(),
  reason: z.string().nullable().optional(),
  timestamp: z.number().int().optional(), // 默认 Date.now()
});
export type AuditLogAppendInput = z.infer<typeof AuditLogAppendInputSchema>;

// ==================== settings ====================

// settings 是 key-value：value 是 unknown，service 层负责 JSON.parse / stringify。
// 调用方应该在自己侧用 zod 校验具体 key 的 value 形态（避免 service 知道所有 key 的类型）。
export const SettingsRowSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  updatedAt: z.number().int(),
});
export type SettingsRow = z.infer<typeof SettingsRowSchema>;

// ==================== installed_skills ====================

export const InstalledSkillSourceSchema = z.enum(["builtin", "user_import", "marketplace"]);
export type InstalledSkillSource = z.infer<typeof InstalledSkillSourceSchema>;

export const InstalledSkillRowSchema = z.object({
  id: z.string(),
  source: InstalledSkillSourceSchema,
  version: z.string(),
  installPath: z.string(),
  enabled: z.boolean(), // 0/1 → boolean
  installedAt: z.number().int(),
});
export type InstalledSkillRow = z.infer<typeof InstalledSkillRowSchema>;

export const InstalledSkillInstallInputSchema = z.object({
  id: z.string(),
  source: InstalledSkillSourceSchema,
  version: z.string(),
  installPath: z.string(),
  enabled: z.boolean().default(true),
});
export type InstalledSkillInstallInput = z.infer<typeof InstalledSkillInstallInputSchema>;

// ==================== 公共 ====================

export const ListPaginationSchema = z.object({
  limit: z.number().int().positive().default(50),
  offset: z.number().int().nonnegative().default(0),
});
export type ListPagination = z.infer<typeof ListPaginationSchema>;
