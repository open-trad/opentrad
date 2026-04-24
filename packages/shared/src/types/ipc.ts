// Electron Main ↔ Renderer IPC 协议。对应 03-architecture.md §3。
// 原则：Renderer 永不直接 spawn CC，只通过 IPC 请求；Main 负责全部子进程管理。

import { z } from "zod";

// -------- Channel 名常量（避免字符串硬编码） --------

export const IpcChannels = {
  CCStartTask: "cc:start-task",
  CCCancelTask: "cc:cancel-task",
  CCEvent: "cc:event",
  CCStatus: "cc:status",
  SkillList: "skill:list",
  SkillInstall: "skill:install",
  SessionList: "session:list",
  SessionResume: "session:resume",
  RiskGateConfirm: "risk-gate:confirm",
  RiskGateResponse: "risk-gate:response",
  SettingsGet: "settings:get",
  SettingsSet: "settings:set",
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];

// -------- cc:start-task（Renderer → Main） --------
// Renderer 提供 skillId 和表单填值，Main 内部 compose prompt / 生成 mcp-config / 派 sessionId。

export const CCStartTaskRequestSchema = z.object({
  skillId: z.string(),
  inputs: z.record(z.string(), z.unknown()),
});

export type CCStartTaskRequest = z.infer<typeof CCStartTaskRequestSchema>;

export const CCStartTaskResponseSchema = z.object({
  sessionId: z.string(),
});

export type CCStartTaskResponse = z.infer<typeof CCStartTaskResponseSchema>;

// -------- cc:cancel-task（Renderer → Main） --------

export const CCCancelTaskRequestSchema = z.object({
  sessionId: z.string(),
});

export type CCCancelTaskRequest = z.infer<typeof CCCancelTaskRequestSchema>;

// -------- cc:event（Main → Renderer push） --------
// payload 直接是 CCEvent（见 cc-event.ts），这里不重复 schema。

// -------- cc:status（双向） --------
// email 是脱敏后的字符串（如 "u***@example.com"），按 03-architecture.md §4.1 F1.3 规定。
// error 用于 CC 检测失败时告诉 Renderer 出了什么事（如"claude binary not found"
// 或"auth status command timeout"），UI 层可直接展示给用户。

export const CCStatusSchema = z.object({
  installed: z.boolean(),
  version: z.string().optional(),
  loggedIn: z.boolean().optional(),
  email: z.string().optional(),
  authMethod: z.enum(["subscription", "api_key"]).optional(),
  error: z.string().optional(),
});

export type CCStatus = z.infer<typeof CCStatusSchema>;

// -------- skill:list（Renderer → Main） --------
// 返回 SkillManifest[]（见 skill.ts）。请求无 payload。

// -------- skill:install（Renderer → Main） --------
// source 可以是本地路径、zip 文件路径或 URL，由 Main 判断。

export const SkillInstallRequestSchema = z.object({
  source: z.string(),
});

export type SkillInstallRequest = z.infer<typeof SkillInstallRequestSchema>;

// -------- session:list（Renderer → Main） --------
// 返回 SessionMeta[]。SessionMeta 是 sessions 表的精简视图（UI 列表需要的字段）。

export const SessionMetaSchema = z.object({
  id: z.string(),
  title: z.string(),
  skillId: z.string().nullable(),
  createdAt: z.number().int(), // epoch ms
  updatedAt: z.number().int(),
  status: z.enum(["active", "completed", "cancelled", "error"]),
});

export type SessionMeta = z.infer<typeof SessionMetaSchema>;

// -------- session:resume（Renderer → Main） --------

export const SessionResumeRequestSchema = z.object({
  sessionId: z.string(),
});

export type SessionResumeRequest = z.infer<typeof SessionResumeRequestSchema>;

// -------- risk-gate:confirm（Main → Renderer push） --------
// payload 是 RiskGateRequest（见 risk-gate.ts）。

// -------- risk-gate:response（Renderer → Main） --------
// payload 是 RiskGateDecision（见 risk-gate.ts）。

// -------- settings:get / settings:set（双向） --------
// value 用 unknown，具体结构由具体设置项决定（SQLite settings 表按 key-value JSON 存）。

export const SettingsGetRequestSchema = z.object({
  key: z.string(),
});

export type SettingsGetRequest = z.infer<typeof SettingsGetRequestSchema>;

export const SettingsSetRequestSchema = z.object({
  key: z.string(),
  value: z.unknown(),
});

export type SettingsSetRequest = z.infer<typeof SettingsSetRequestSchema>;
