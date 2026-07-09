import { describe, expect, it } from "vitest";
import { SkillInputSchema, SkillManifestSchema } from "../src";

describe("SkillInput schema", () => {
  it("accepts a text input", () => {
    expect(
      SkillInputSchema.safeParse({
        name: "context",
        type: "text",
        label: "邮件场景描述",
      }).success,
    ).toBe(true);
  });

  it("accepts a select input with options", () => {
    expect(
      SkillInputSchema.safeParse({
        name: "tone",
        type: "select",
        label: "语气",
        options: ["formal", "friendly"],
      }).success,
    ).toBe(true);
  });

  it("rejects unknown input type", () => {
    expect(
      SkillInputSchema.safeParse({
        name: "x",
        type: "checkbox",
        label: "x",
      }).success,
    ).toBe(false);
  });
});

describe("SkillManifest schema", () => {
  it("parses a full manifest for trade-email-writer", () => {
    const raw = {
      id: "trade-email-writer",
      title: "外贸邮件写作",
      version: "1.0.0",
      description: "生成各类外贸邮件草稿",
      category: "communication",
      riskLevel: "draft_only",
      allowedTools: ["Read", "Write", "WebSearch"],
      disallowedTools: ["Bash(*)"],
      stopBefore: ["send_email"],
      inputs: [{ name: "context", type: "text", label: "场景", required: true }],
      outputs: ["draft_email", "subject_line"],
      promptTemplate: "prompt.md",
    };
    expect(SkillManifestSchema.safeParse(raw).success).toBe(true);
  });

  it("rejects invalid category", () => {
    const raw = {
      id: "x",
      title: "x",
      version: "1.0",
      description: "x",
      category: "cooking",
      riskLevel: "draft_only",
      allowedTools: [],
      inputs: [],
      outputs: [],
      promptTemplate: "p.md",
    };
    expect(SkillManifestSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects invalid riskLevel", () => {
    const raw = {
      id: "x",
      title: "x",
      version: "1.0",
      description: "x",
      category: "other",
      riskLevel: "dangerous",
      allowedTools: [],
      inputs: [],
      outputs: [],
      promptTemplate: "p.md",
    };
    expect(SkillManifestSchema.safeParse(raw).success).toBe(false);
  });
});
