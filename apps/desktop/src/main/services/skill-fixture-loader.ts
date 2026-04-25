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
import { createRequire } from "node:module";
import { join } from "node:path";
import { type SkillManifest, SkillManifestSchema } from "@opentrad/shared";
import * as yaml from "js-yaml";

// fixture 路径解析:dev / packaged / vitest 三种环境路径深度不同。
//
// - vitest:跑 src/main/services/skill-fixture-loader.ts,__dirname 是源码目录,
//   5 层 ".." 上溯到 monorepo root。
// - electron(dev / packaged):main bundle 到 apps/desktop/out/main/index.js,
//   __dirname 路径深度变化,5 层 ".." 会跑到错误目录(M1 #21 dev 验证 bug A)。
//   改用 electron app.getAppPath()(返回 apps/desktop),上 2 层到 monorepo root。
//
// 探测靠 process.versions.electron(electron 进程独有);vitest 走 fallback。
// createRequire 同步加载 electron(模块顶层用 dynamic import 不行,本函数同步)。
//
// **#23 (M1 #6) SkillLoader 落地后本文件删除**,届时 packaged 走 ~/.opentrad/skills/,
// 此 path 解析也随之退场。
function resolveFixtureDir(): string {
  if (process.versions?.electron) {
    const requireFromHere = createRequire(import.meta.url);
    const electron = requireFromHere("electron") as { app: { getAppPath: () => string } };
    // app.getAppPath() = apps/desktop;monorepo root 是上 2 层
    return join(electron.app.getAppPath(), "..", "..", "packages", "skill-runtime", "__fixtures__");
  }
  // vitest fallback:src/main/services → 5 ".." → monorepo root
  return join(__dirname, "..", "..", "..", "..", "..", "packages", "skill-runtime", "__fixtures__");
}

// 模块加载时不解析(electron require 在 vitest import 时不应触发);
// loadFixtureSkill 调用时再解析,带 cache 避免每次 require。
let cachedFixtureDir: string | undefined;
function getFixtureDir(): string {
  if (!cachedFixtureDir) cachedFixtureDir = resolveFixtureDir();
  return cachedFixtureDir;
}

export interface LoadedSkill {
  manifest: SkillManifest;
  promptTemplate: string; // 已读出来的 prompt.md 文本
}

export function loadFixtureSkill(skillId: string): LoadedSkill {
  const skillDir = join(getFixtureDir(), skillId);
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
