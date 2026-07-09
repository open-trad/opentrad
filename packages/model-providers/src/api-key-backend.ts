// ApiKeyBackend：API key 直连后端（ADR-001 D2 的根基通道，M0 spike 实现）。
//
// AI SDK 版本决策（2026-07-08 核实）：
// - 采用 ai@6.0.221（npm dist-tag `ai-v6`，已 GA）+ 配套 v6 兼容 provider 线：
//   @ai-sdk/anthropic@3.0.95 / @ai-sdk/openai@3.0.82 / @ai-sdk/openai-compatible@2.0.58
// - npm latest 此刻已是 ai v7，但 ADR-001 明确锁定 "Vercel AI SDK 6 ToolLoopAgent" 且
//   把"版本锁定"列为风险对策，故停留在 v6 维护线；v7 升级另行评估（届时只动本包与 agent-core）。
//
// 逃生门约束：AI SDK 类型不出包边界——resolveModel() 对外返回 unknown。

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ChatBackend, CredentialStore, ProviderKind, ProviderProfile } from "./types";

export class ApiKeyBackend implements ChatBackend {
  readonly profileId: string;
  readonly kind: ProviderKind;

  constructor(
    private readonly profile: ProviderProfile,
    private readonly credentials: CredentialStore,
  ) {
    this.profileId = profile.id;
    this.kind = profile.kind;
  }

  // 按 profile.kind 绑定官方 provider 包并返回 AI SDK LanguageModel（对外 unknown）。
  // 凭证每次现取现用：不缓存、不落明文（safeStorage 里的密文由 CredentialStore 实现解密）。
  async resolveModel(): Promise<unknown> {
    const { profile } = this;
    switch (profile.kind) {
      case "anthropic": {
        const apiKey = await this.requireApiKey();
        return createAnthropic({ apiKey, baseURL: profile.baseUrl })(profile.model);
      }
      case "openai": {
        const apiKey = await this.requireApiKey();
        return createOpenAI({ apiKey, baseURL: profile.baseUrl })(profile.model);
      }
      case "openai-compatible": {
        // 一份代码覆盖 DeepSeek/通义/Moonshot 等：baseUrl 必填
        if (!profile.baseUrl) {
          throw new Error(`profile ${profile.id}: openai-compatible requires baseUrl`);
        }
        const apiKey = await this.requireApiKey();
        return createOpenAICompatible({
          name: profile.id,
          baseURL: profile.baseUrl,
          apiKey,
        })(profile.model);
      }
      case "claude-subscription":
        // 订阅通道 = SubscriptionBackend（cc-adapter 收编），M5 实验 flag 才放出
        throw new Error(
          `profile ${profile.id}: claude-subscription backend is not available yet (planned for M5 behind an experimental flag)`,
        );
    }
  }

  private async requireApiKey(): Promise<string> {
    const ref = this.profile.credentialRef;
    if (!ref) {
      throw new Error(`profile ${this.profile.id}: missing credentialRef for kind ${this.kind}`);
    }
    const apiKey = await this.credentials.get(ref);
    if (!apiKey) {
      // log 不带任何凭证内容，只带引用键
      throw new Error(`profile ${this.profile.id}: credential not found for ref ${ref}`);
    }
    return apiKey;
  }
}
