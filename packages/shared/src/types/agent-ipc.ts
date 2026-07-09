// agent:* IPC 协议（M0 spike：自建 agent loop 的 desktop 接线）。
// 通道常量在 ../channels.ts；本文件只放 main 进程 handler 校验用的 zod schemas。
//
// 注意：ProviderProfile 的 zod schema 在 @opentrad/model-providers（其 domain 归属包）。
// agent:profiles:save 的 payload 里 profile 用 unknown 透传，main handler 用
// ProviderProfileSchema 校验——避免 shared 与 model-providers 两处重复定义漂移。

import { z } from "zod";

// stdio MCP server 挂载配置（wire 形态；与 tool-host 的 McpServerConfig 结构一致）
export const AgentMcpServerConfigSchema = z.object({
  // 命名空间名（工具注册为 "mcp:<name>:<tool>"）
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});
export type AgentMcpServerConfig = z.infer<typeof AgentMcpServerConfigSchema>;

// -------- agent:start-session（Renderer → Main） --------

export const AgentStartSessionRequestSchema = z.object({
  profileId: z.string().min(1),
  systemPrompt: z.string().optional(),
  // loop 安全阀：M0 默认 50 步、上限 200
  maxSteps: z.number().int().positive().max(200).default(50),
  // 单会话成本硬顶（USD）；null = 不设预算
  budgetUsd: z.number().positive().nullable().default(null),
  // 会话启动时启用的 bb-browser 选品站点 id（在插件页开关，注册为 site:<id> 工具）
  enabledSites: z.array(z.string()).default([]),
  // 会话启动时挂载的 stdio MCP servers（DIY 用户自挂的自定义 server）
  mcpServers: z.array(AgentMcpServerConfigSchema).default([]),
});
export type AgentStartSessionRequest = z.infer<typeof AgentStartSessionRequestSchema>;

export const AgentStartSessionResponseSchema = z.object({
  sessionId: z.string(),
});
export type AgentStartSessionResponse = z.infer<typeof AgentStartSessionResponseSchema>;

// -------- agent:send（Renderer → Main；fire-and-forget，事件经 agent:event 推回） --------

export const AgentSendRequestSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
});
export type AgentSendRequest = z.infer<typeof AgentSendRequestSchema>;

// -------- agent:abort（Renderer → Main） --------

export const AgentAbortRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type AgentAbortRequest = z.infer<typeof AgentAbortRequestSchema>;

// -------- agent:event（Main → Renderer push） --------
// payload 是 AgentEvent（见 agent-event.ts），不重复 schema。

// -------- agent:profiles:*（Renderer → Main） --------

export const AgentProfileSaveRequestSchema = z.object({
  // main handler 用 @opentrad/model-providers 的 ProviderProfileSchema 校验
  profile: z.unknown(),
});
export type AgentProfileSaveRequest = z.infer<typeof AgentProfileSaveRequestSchema>;

export const AgentProfileDeleteRequestSchema = z.object({
  id: z.string().min(1),
});
export type AgentProfileDeleteRequest = z.infer<typeof AgentProfileDeleteRequestSchema>;

// -------- agent:credentials:*（Renderer → Main） --------
// secret 只进 main 进程 safeStorage 加密落库，绝不回读给 renderer、绝不进 log。

export const AgentCredentialSetRequestSchema = z.object({
  ref: z.string().min(1),
  secret: z.string().min(1),
});
export type AgentCredentialSetRequest = z.infer<typeof AgentCredentialSetRequestSchema>;

export const AgentCredentialDeleteRequestSchema = z.object({
  ref: z.string().min(1),
});
export type AgentCredentialDeleteRequest = z.infer<typeof AgentCredentialDeleteRequestSchema>;

// -------- agent:sessions:list / agent:session:load（会话历史） --------

export interface AgentSessionMeta {
  sessionId: string;
  title: string | null;
  model: string | null;
  createdAt: number;
}

export const AgentSessionLoadRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type AgentSessionLoadRequest = z.infer<typeof AgentSessionLoadRequestSchema>;

// 用户消息事件（持久化在 agent_events，回放时 renderer 据此重建 user item）
export interface AgentUserEvent {
  type: "agent_user";
  sessionId: string;
  text: string;
}
