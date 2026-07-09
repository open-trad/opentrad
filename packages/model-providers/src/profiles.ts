// ProviderProfile 注册表：内存实现 + 校验。
// desktop 侧持久化到 SQLite（profiles 表，M1），本包不依赖存储介质。

import { type ProviderProfile, ProviderProfileSchema } from "./types";

export class ProfileRegistry {
  private profiles = new Map<string, ProviderProfile>();

  // 注册（或覆盖）一个 profile；zod 校验失败抛错
  register(input: unknown): ProviderProfile {
    const profile = ProviderProfileSchema.parse(input);
    if (profile.kind === "openai-compatible" && !profile.baseUrl) {
      throw new Error(`profile ${profile.id}: openai-compatible requires baseUrl`);
    }
    this.profiles.set(profile.id, profile);
    return profile;
  }

  get(id: string): ProviderProfile | undefined {
    return this.profiles.get(id);
  }

  list(): ProviderProfile[] {
    return [...this.profiles.values()];
  }

  remove(id: string): boolean {
    return this.profiles.delete(id);
  }
}
