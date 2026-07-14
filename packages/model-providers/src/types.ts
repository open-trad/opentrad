// 模型 provider 层核心契约（ADR-001）。
// 设计原则：
// - API key 直连是根基通道；订阅复用（SubscriptionBackend）是可选实验通道，随时可关不伤主干
// - 凭证一律存 Electron safeStorage（OS keychain），这里只持有 credentialRef 引用，绝不落明文
// - Profile = provider + 凭证引用 + 模型偏好，用户可建多个（如"DeepSeek 跑选品 / Claude 跑 listing"）

import { HermesProviderIdentifierSchema } from "@opentrad/shared";
import { z } from "zod";

// 支持的 provider 种类。openai-compatible 一份代码覆盖 DeepSeek/通义/Moonshot 等国产模型
export const ProviderKindSchema = z.enum([
  "anthropic",
  "openai",
  "openai-compatible",
  // 订阅通道：经官方 Claude Code CLI 进程（cc-adapter 收编），非裸 OAuth——政策合规通道，实验 flag
  "claude-subscription",
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const HermesProviderMetadataSchema = z
  .object({
    providerSlug: HermesProviderIdentifierSchema,
    authMode: z.enum(["api_key", "oauth"]),
    apiMode: z.enum(["chat_completions", "codex_responses"]),
    executionBackend: z.enum(["local", "docker"]),
  })
  .strict();
export type HermesProviderMetadata = z.infer<typeof HermesProviderMetadataSchema>;

const ProviderProfileInputSchema = z.object({
  id: HermesProviderIdentifierSchema,
  displayName: z.string(),
  kind: ProviderKindSchema,
  // openai-compatible 必填：如 https://api.deepseek.com/v1
  baseUrl: z.string().optional(),
  model: z.string(),
  // safeStorage 凭证引用键；claude-subscription 无需凭证（复用 CLI 登录态）
  credentialRef: z.string().optional(),
  // 每百万 token 定价（USD），用于 usage 成本估算；未知则 null
  pricing: z
    .object({
      inputPerMTokUsd: z.number(),
      outputPerMTokUsd: z.number(),
    })
    .nullable()
    .default(null),
  hermes: HermesProviderMetadataSchema.optional(),
});

export const ProviderProfileSchema = ProviderProfileInputSchema.transform((profile) => ({
  ...profile,
  hermes: profile.hermes ?? inferHermesMetadata(profile),
}));
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

export function requiresHermesRelogin(profile: Pick<ProviderProfile, "kind">): boolean {
  return profile.kind === "claude-subscription";
}

function inferHermesMetadata(
  profile: z.infer<typeof ProviderProfileInputSchema>,
): HermesProviderMetadata {
  const common = {
    apiMode: "chat_completions" as const,
    executionBackend: "local" as const,
  };

  switch (profile.kind) {
    case "anthropic":
      return { ...common, providerSlug: "anthropic", authMode: "api_key" };
    case "openai":
      return {
        ...common,
        providerSlug: "openai-api",
        authMode: "api_key",
        apiMode: "codex_responses",
      };
    case "claude-subscription":
      return { ...common, providerSlug: "anthropic", authMode: "oauth" };
    case "openai-compatible":
      return {
        ...common,
        providerSlug: isDeepSeekEndpoint(profile.baseUrl)
          ? "deepseek"
          : `custom:${normalizeCustomProviderId(profile.id)}`,
        authMode: "api_key",
      };
  }
}

function normalizeCustomProviderId(profileId: string): string {
  const maxProviderIdLength = 128 - "custom:".length;
  const normalized = profileId.toLowerCase().replace(/:+/gu, "-");
  if (normalized.length <= maxProviderIdLength) return normalized;
  const suffix = stableIdentifierHash(normalized);
  return `${normalized.slice(0, maxProviderIdLength - suffix.length - 1)}-${suffix}`;
}

function stableIdentifierHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isDeepSeekEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}

// 统一聊天后端接口：agent-core 只面向这个接口，不感知具体 provider。
// 具体实现：
// - ApiKeyBackend（M0 spike，基于 AI SDK 的 LanguageModel 绑定）
// - SubscriptionBackend（M5 实验 flag，cc-adapter + stream-parser 收编适配）
export interface ChatBackend {
  readonly profileId: string;
  readonly kind: ProviderKind;
  // 返回底层模型句柄。M0 spike 中为 AI SDK 的 LanguageModel 实例；
  // 类型上用 unknown 隔离，避免 AI SDK 类型外泄到消费方（逃生门约束）
  resolveModel(): Promise<unknown>;
}

// 凭证存取接口：desktop 主进程用 safeStorage 实现；测试用内存实现
export interface CredentialStore {
  get(ref: string): Promise<string | null>;
  set(ref: string, secret: string): Promise<void>;
  delete(ref: string): Promise<void>;
}
