// skill-fixture-loader 测试：验证 fixture skill 加载 + manifest schema 解析 +
// composePrompt 替换 mustache + 必填字段校验。
//
// 覆盖跟 #23 (M1 #6) SkillLoader 等价的最小功能集，确保 fixture 字段齐全（
// stub != mock 的发起人约束）。#23 真做时 SkillLoader 测试也用本 fixture。

import { describe, expect, it } from "vitest";
import {
  composePrompt,
  loadFixtureSkill,
  ValidationError,
} from "../src/main/services/skill-fixture-loader";

describe("loadFixtureSkill", () => {
  it("加载 fixture-skill 返回完整 SkillManifest", () => {
    const loaded = loadFixtureSkill("sample-skill");
    expect(loaded.manifest.id).toBe("fixture-skill");
    expect(loaded.manifest.title).toBe("Fixture Test Skill");
    expect(loaded.manifest.version).toBe("0.1.0");
    expect(loaded.manifest.category).toBe("communication");
    expect(loaded.manifest.riskLevel).toBe("draft_only");
    expect(loaded.manifest.allowedTools).toEqual([
      "mcp__opentrad__echo",
      "mcp__opentrad__draft_save",
    ]);
    expect(loaded.manifest.disallowedTools).toEqual(["Bash(*)", "mcp__*__send*"]);
    expect(loaded.manifest.inputs).toHaveLength(1);
    expect(loaded.manifest.inputs[0]?.name).toBe("topic");
    expect(loaded.manifest.outputs).toEqual(["draft"]);
    expect(loaded.promptTemplate).toContain("{{topic}}");
  });

  it("不存在的 skillId 抛错", () => {
    expect(() => loadFixtureSkill("does-not-exist")).toThrow(/not found/);
  });
});

describe("composePrompt", () => {
  it("替换 {{varName}} 占位符 + 加通用前缀", () => {
    const loaded = loadFixtureSkill("sample-skill");
    const result = composePrompt(loaded, { topic: "测试主题" });
    expect(result).toContain("OpenTrad's fixture-skill skill");
    expect(result).toContain("Stay within scope");
    expect(result).toContain("测试主题");
    expect(result).not.toContain("{{topic}}");
  });

  it("必填 input 缺失时抛 ValidationError", () => {
    const loaded = loadFixtureSkill("sample-skill");
    expect(() => composePrompt(loaded, {})).toThrow(ValidationError);
  });

  it("非必填字段缺失时不抛，{{x}} 替换为空串（M1 简化，#23 真做时收紧）", () => {
    // sample-skill 的 topic 是 required，构造一个 manifest 副本验证非必填路径
    const loaded = loadFixtureSkill("sample-skill");
    const firstInput = loaded.manifest.inputs[0];
    if (!firstInput) throw new Error("fixture should have at least one input");
    const optionalLoaded = {
      ...loaded,
      manifest: {
        ...loaded.manifest,
        inputs: [{ ...firstInput, required: false }],
      },
      promptTemplate: "Hello {{topic}}, age {{age}}.",
    };
    const result = composePrompt(optionalLoaded, { topic: "Alice" });
    expect(result).toContain("Hello Alice, age .");
  });
});
