import { describe, expect, it } from "vitest";
import { catalogModelToProfileFields, PROVIDER_CATALOG } from "../src/catalog";
import { ProviderProfileSchema } from "../src/types";

describe("PROVIDER_CATALOG", () => {
  it("每个 provider 结构合法：openai-compatible 必带 baseUrl，非空型号", () => {
    for (const p of PROVIDER_CATALOG) {
      expect(p.models.length).toBeGreaterThan(0);
      if (p.kind === "openai-compatible") {
        expect(p.baseUrl, `${p.id} 缺 baseUrl`).toBeTruthy();
      }
      for (const m of p.models) {
        expect(m.id).toBeTruthy();
        expect(m.inputPerMTokUsd).toBeGreaterThanOrEqual(0);
        expect(m.outputPerMTokUsd).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("provider id 唯一、每个 provider 内 model id 唯一", () => {
    const pids = PROVIDER_CATALOG.map((p) => p.id);
    expect(new Set(pids).size).toBe(pids.length);
    for (const p of PROVIDER_CATALOG) {
      const mids = p.models.map((m) => m.id);
      expect(new Set(mids).size, `${p.id} model id 重复`).toBe(mids.length);
    }
  });

  it("catalogModelToProfileFields 产物能通过 ProviderProfile 校验", () => {
    for (const p of PROVIDER_CATALOG) {
      for (const m of p.models) {
        const fields = catalogModelToProfileFields(p.id, m.id);
        expect(fields.kind).toBe(p.kind);
        expect(fields.model).toBe(m.id);
        // 补 id/displayName/credentialRef 后应是合法 profile
        const profile = ProviderProfileSchema.parse({
          id: `${p.id}-${m.id}`,
          displayName: m.displayName,
          credentialRef: `provider.${p.id}.apiKey`,
          ...fields,
        });
        expect(profile.pricing?.inputPerMTokUsd).toBe(m.inputPerMTokUsd);
      }
    }
  });

  it("未知 provider / model 抛错", () => {
    expect(() => catalogModelToProfileFields("nope", "x")).toThrow(/unknown provider/);
    expect(() => catalogModelToProfileFields("anthropic", "nope")).toThrow(/unknown model/);
  });
});
