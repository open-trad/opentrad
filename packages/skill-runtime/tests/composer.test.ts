// PromptComposer 测试:必填校验 + mustache 替换 + 通用前缀。

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compose, PromptComposer } from "../src/composer";
import { ValidationError } from "../src/errors";
import { type LoadedSkill, loadFromDirectory } from "../src/loader";

const FIXTURE_SAMPLE_SKILL = join(__dirname, "..", "__fixtures__", "sample-skill");

function loadSample(): LoadedSkill {
  return loadFromDirectory(FIXTURE_SAMPLE_SKILL);
}

describe("PromptComposer.compose / compose", () => {
  it("替换 {{varName}} 占位符 + 加通用前缀", () => {
    const skill = loadSample();
    const result = compose(skill, { topic: "测试主题" });
    expect(result).toContain("OpenTrad's fixture-skill skill");
    expect(result).toContain("Stay within scope");
    expect(result).toContain("测试主题");
    expect(result).not.toContain("{{topic}}");
  });

  it("通用前缀格式对齐 03 §4.3", () => {
    const skill = loadSample();
    const result = compose(skill, { topic: "x" });
    // 前缀:`You are operating within OpenTrad's <id> skill. <description>. Stay within scope.\n\n`
    expect(result.startsWith("You are operating within OpenTrad's fixture-skill skill.")).toBe(
      true,
    );
    expect(result).toContain(skill.manifest.description);
  });

  it("必填 input 缺失抛 ValidationError", () => {
    const skill = loadSample();
    expect(() => compose(skill, {})).toThrow(ValidationError);
  });

  it("非必填字段缺失,{{x}} 替换为空串(M1 简化,#23 决策点 D-M1-2)", () => {
    const baseSkill = loadSample();
    const firstInput = baseSkill.manifest.inputs[0];
    if (!firstInput) throw new Error("fixture should have at least one input");
    const optionalSkill: LoadedSkill = {
      ...baseSkill,
      manifest: {
        ...baseSkill.manifest,
        inputs: [{ ...firstInput, required: false }],
      },
      promptTemplate: "Hello {{topic}}, age {{age}}.",
    };
    const result = compose(optionalSkill, { topic: "Alice" });
    expect(result).toContain("Hello Alice, age .");
  });

  it("PromptComposer.compose 与 compose 函数等价", () => {
    const skill = loadSample();
    const a = compose(skill, { topic: "x" });
    const b = PromptComposer.compose(skill, { topic: "x" });
    expect(a).toBe(b);
  });

  it("null / undefined input 替换为空串(不抛)", () => {
    const baseSkill = loadSample();
    const firstInput = baseSkill.manifest.inputs[0];
    if (!firstInput) throw new Error("fixture should have at least one input");
    const skill: LoadedSkill = {
      ...baseSkill,
      manifest: {
        ...baseSkill.manifest,
        inputs: [{ ...firstInput, required: false }],
      },
      promptTemplate: "[{{topic}}]",
    };
    expect(compose(skill, { topic: undefined })).toContain("[]");
    expect(compose(skill, { topic: null })).toContain("[]");
  });
});
