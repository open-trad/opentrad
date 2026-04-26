// Electron Main ↔ Renderer IPC 协议。对应 03-architecture.md §3。
// 原则：Renderer 永不直接 spawn CC，只通过 IPC 请求；Main 负责全部子进程管理。
//
// IpcChannels / IpcChannel 已拆到 ../channels.ts（纯 const，不 import zod）。
// preload 必须从 "@opentrad/shared/channels" 子路径 import，避免触发 zod
// evaluation chain（详见 channels.ts 的 module-level 注释）。
// 本文件保留 zod schemas 用于 main 进程的 IPC handler 校验。

import { z } from "zod";

export { type IpcChannel, IpcChannels } from "../channels";

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

export const SessionListRequestSchema = z.object({
  limit: z.number().int().positive().default(50),
  offset: z.number().int().nonnegative().default(0),
});

export type SessionListRequest = z.infer<typeof SessionListRequestSchema>;

// -------- session:get（Renderer → Main） --------
// 返回 SessionRow（完整字段；含 lastModel / totalCostUsd / messageCount / ccSessionPath）或 null。

export const SessionGetRequestSchema = z.object({
  sessionId: z.string(),
});

export type SessionGetRequest = z.infer<typeof SessionGetRequestSchema>;

// -------- session:delete（Renderer → Main） --------
// events 通过 FK ON DELETE CASCADE 自动清理。

export const SessionDeleteRequestSchema = z.object({
  sessionId: z.string(),
});

export type SessionDeleteRequest = z.infer<typeof SessionDeleteRequestSchema>;

// -------- session:resume（Renderer → Main） --------
// M1 #29 D-M1-7:M1 只查看不重启 CC,response 含 SessionMeta + 完整 events 数组。
// events 是 CCEvent[](payload 已 normalize 后 union),不在本 schema 内重复 zod 校验
// (CCEvent discriminated union 复杂,renderer 信任 main 端 normalize 输出)。
// 不存在的 sessionId → null。

export const SessionResumeRequestSchema = z.object({
  sessionId: z.string(),
});

export type SessionResumeRequest = z.infer<typeof SessionResumeRequestSchema>;

// 注:CCEvent 类型在 cc-event.ts;本 interface 直接 import 引用,不走 zod schema
// (避免 union 序列化复杂度,M1 实测层 wire 校验已在 stream-parser 完成)。
import type { CCEvent } from "./cc-event";

export interface SessionResumeResponse {
  session: SessionMeta;
  events: CCEvent[];
}

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
