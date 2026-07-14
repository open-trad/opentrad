// agent:* IPC 协议（M0 spike：自建 agent loop 的 desktop 接线）。
// 通道常量在 ../channels.ts；本文件只放 main 进程 handler 校验用的 zod schemas。
//
// 注意：ProviderProfile 的 zod schema 在 @opentrad/model-providers（其 domain 归属包）。
// agent:profiles:save 的 payload 里 profile 用 unknown 透传，main handler 用
// ProviderProfileSchema 校验——避免 shared 与 model-providers 两处重复定义漂移。

import { z } from "zod";

const HermesInteractionRequestIdSchema = z.string().uuid();
const HermesInteractionDisplayTextSchema = z
  .string()
  .max(4_096)
  .refine((value) => !value.includes("\0") && new TextEncoder().encode(value).length <= 16_384);
const HermesSudoValueSchema = z
  .string()
  .max(4_096)
  .refine((value) => !value.includes("\0") && new TextEncoder().encode(value).length <= 16_384);
const HermesSecretValueSchema = z
  .string()
  .max(65_536)
  .refine((value) => !value.includes("\0") && new TextEncoder().encode(value).length <= 262_144);

const HermesInteractionRequestBase = {
  requestId: HermesInteractionRequestIdSchema,
  sessionId: z.string().min(1),
};

export const HermesInteractionRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...HermesInteractionRequestBase,
      kind: z.literal("approval"),
      toolName: HermesInteractionDisplayTextSchema.optional(),
      pluginName: HermesInteractionDisplayTextSchema.optional(),
      command: HermesInteractionDisplayTextSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...HermesInteractionRequestBase,
      kind: z.literal("sudo"),
      prompt: HermesInteractionDisplayTextSchema.optional(),
      command: HermesInteractionDisplayTextSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...HermesInteractionRequestBase,
      kind: z.literal("secret"),
      prompt: HermesInteractionDisplayTextSchema.optional(),
      secretName: HermesInteractionDisplayTextSchema.optional(),
    })
    .strict(),
]);
export type HermesInteractionRequest = z.infer<typeof HermesInteractionRequestSchema>;

export const HermesInteractionResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      requestId: HermesInteractionRequestIdSchema,
      kind: z.literal("approval"),
      choice: z.enum(["once", "session", "always", "deny"]),
    })
    .strict(),
  z
    .object({
      requestId: HermesInteractionRequestIdSchema,
      kind: z.literal("sudo"),
      value: HermesSudoValueSchema,
    })
    .strict(),
  z
    .object({
      requestId: HermesInteractionRequestIdSchema,
      kind: z.literal("secret"),
      value: HermesSecretValueSchema,
    })
    .strict(),
]);
export type HermesInteractionResponse = z.infer<typeof HermesInteractionResponseSchema>;

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
  // Renderer selection is only a hint; main resolves and revalidates it before launch.
  workspaceRoot: z.string().min(1),
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
  resumable: z.boolean(),
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

const AgentCredentialRefSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0") && new TextEncoder().encode(value).length <= 2_048);
const AgentCredentialSecretSchema = z
  .string()
  .min(1)
  .max(65_536)
  .refine((value) => !value.includes("\0") && new TextEncoder().encode(value).length <= 262_144);

export const AgentProfileCredentialSchema = z
  .object({
    ref: AgentCredentialRefSchema,
    secret: AgentCredentialSecretSchema,
  })
  .strict();
export type AgentProfileCredential = z.infer<typeof AgentProfileCredentialSchema>;

export const AgentProfileSaveRequestSchema = z
  .object({
    // main handler 用 @opentrad/model-providers 的 ProviderProfileSchema 校验
    profile: z.unknown(),
    // secret 只进 main 的单一 Profile mutation；绝不回读、落 profile JSON 或进入日志。
    credential: AgentProfileCredentialSchema.optional(),
  })
  .strict();
export type AgentProfileSaveRequest = z.infer<typeof AgentProfileSaveRequestSchema>;

export const AgentProfileDeleteRequestSchema = z.object({
  id: z.string().min(1),
});
export type AgentProfileDeleteRequest = z.infer<typeof AgentProfileDeleteRequestSchema>;

// -------- agent:sessions:list / agent:session:load（会话历史） --------

export const AgentSessionStatusSchema = z.enum([
  "creating",
  "active",
  "idle",
  "resuming",
  "interrupted",
  "closed",
  "error",
  "read_only",
]);
export type AgentSessionStatus = z.infer<typeof AgentSessionStatusSchema>;

const AgentSessionMetaBaseSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().nullable(),
  model: z.string().nullable(),
  createdAt: z.number(),
});

const AgentSessionMetaWithBindingSchema = AgentSessionMetaBaseSchema.extend({
  profileId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  status: AgentSessionStatusSchema,
  resumable: z.boolean(),
});

// Rows created before native runtime bindings have none of these fields. Declaring
// them as optional undefined keeps that wire shape readable while ensuring a
// partially joined/corrupt binding can never cross the IPC boundary.
const LegacyAgentSessionMetaSchema = AgentSessionMetaBaseSchema.extend({
  profileId: z.undefined().optional(),
  workspaceRoot: z.undefined().optional(),
  status: z.undefined().optional(),
  resumable: z.undefined().optional(),
});

export const AgentSessionMetaSchema = z.union([
  AgentSessionMetaWithBindingSchema,
  LegacyAgentSessionMetaSchema,
]);
export type AgentSessionMeta = z.infer<typeof AgentSessionMetaSchema>;

export const AgentSessionLoadRequestSchema = z.object({
  sessionId: z.string().min(1),
});
export type AgentSessionLoadRequest = z.infer<typeof AgentSessionLoadRequestSchema>;

// -------- agent:session:open（立即本地回放；main 后台恢复 durable binding） --------

export const AgentSessionOpenRequestSchema = AgentSessionLoadRequestSchema;
export type AgentSessionOpenRequest = z.infer<typeof AgentSessionOpenRequestSchema>;

export const AgentSessionOpenResponseSchema = z.object({
  session: AgentSessionMetaSchema,
  events: z.array(z.unknown()),
  recovery: z.enum(["live", "resuming", "read_only"]),
});
export type AgentSessionOpenResponse = z.infer<typeof AgentSessionOpenResponseSchema>;

// Workspace selection always originates from a main-owned native directory picker.
export const AgentWorkspaceSelectResponseSchema = z
  .object({ workspaceRoot: z.string().min(1) })
  .nullable();
export type AgentWorkspaceSelectResponse = z.infer<typeof AgentWorkspaceSelectResponseSchema>;

// 用户消息事件（持久化在 agent_events，回放时 renderer 据此重建 user item）
export interface AgentUserEvent {
  type: "agent_user";
  sessionId: string;
  text: string;
}
