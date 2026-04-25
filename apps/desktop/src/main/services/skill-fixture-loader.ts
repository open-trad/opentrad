// **临时 fixture loader（M1 #26 / open-trad/opentrad#26）**：
// 读 packages/skill-runtime/__fixtures__/sample-skill/{skill.yml,prompt.md}，
// 用 zod 校验后返回 SkillManifest。
//
// **#23 (M1 #6) SkillLoader / PromptComposer 落地后删除本文件**，把 desktop
// 这边 import 切到 `@opentrad/skill-runtime`，业务行为不变。
//
// 设计动机（W1 PR A 教训 + 发起人 W2 起跑要求）：fixture 字段齐全（不是临时
// mock），#23 真做时 SkillLoader 加载它跑通解析路径；#7 / #24 SkillPicker
// UI 也复用同一个 fixture 演示输入表单。M0 D6 "per-message 退化为
// per-wire-event" 教训：临时简化的边界一旦写死，后续接管时容易漏改。
// 这里坚持 stub != mock，full-fidelity fixture。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type SkillManifest, SkillManifestSchema } from "@opentrad/shared";
import * as yaml from "js-yaml";

// fixture 仓库内绝对路径。从 desktop 的 dist 跑时通过相对 monorepo 解析。
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const FIXTURE_DIR = join(REPO_ROOT, "packages", "skill-runtime", "__fixtures__");

export interface LoadedSkill {
  manifest: SkillManifest;
  promptTemplate: string; // 已读出来的 prompt.md 文本
}

export function loadFixtureSkill(skillId: string): LoadedSkill {
  const skillDir = join(FIXTURE_DIR, skillId);
  const yamlPath = join(skillDir, "skill.yml");
  if (!existsSync(yamlPath)) {
    throw new Error(`fixture skill not found: ${skillId} (looked at ${yamlPath})`);
  }

  const raw = yaml.load(readFileSync(yamlPath, "utf-8"));
  const manifest = SkillManifestSchema.parse(raw);

  const promptPath = join(skillDir, manifest.promptTemplate);
  if (!existsSync(promptPath)) {
    throw new Error(`fixture skill prompt not found: ${promptPath}`);
  }
  const promptTemplate = readFileSync(promptPath, "utf-8");

  return { manifest, promptTemplate };
}

// mustache-style 占位符替换 + 通用前缀注入（对齐 03 §4.3 PromptComposer 设计）。
// 必填 input 缺失时抛 ValidationError；`{{x}}` 缺值时替换为空串（#23 真实化时收紧）。
export function composePrompt(loaded: LoadedSkill, inputs: Record<string, unknown>): string {
  const { manifest, promptTemplate } = loaded;

  // 必填字段校验
  for (const input of manifest.inputs) {
    if (input.required && !(input.name in inputs)) {
      throw new ValidationError(`missing required input: ${input.name}`);
    }
  }

  // mustache 替换 {{varName}}
  const filled = promptTemplate.replace(/\{\{(\w+)\}\}/g, (_, varName) => {
    const v = inputs[varName];
    return v === undefined || v === null ? "" : String(v);
  });

  // 通用前缀（对齐 03 §4.3）
  const prefix = `You are operating within OpenTrad's ${manifest.id} skill. ${manifest.description}. Stay within scope.\n\n`;
  return prefix + filled;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
