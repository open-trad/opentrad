// SkillLoader：扫描 skill 目录,读 skill.yml + prompt.md,zod 校验后返回 LoadedSkill。
//
// 03-architecture.md §4.3 SkillManifest + SkillLoader。issue M1 #6 (#23) 决策点 D-M1-2:
// - 加载失败的 skill 不阻塞其他 skill(per-skill try/catch)
// - skill manifest 的 version 字段 M1 仅校验存在,不做 semver 比对
//
// 三个加载入口:
// - loadFromDirectory(dir):单 skill 加载,失败抛 SkillLoadError(精确诊断 + 给上层包装语境)
// - loadBuiltinSkills(skillsDir):扫描内置 skill 目录,per-skill try/catch,返回 LoadResult[]
// - loadUserSkills(userSkillsDir):同上,但 dir 不存在视为正常空数组(M1 友好,先建用户目录前不报错)

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type SkillManifest, SkillManifestSchema } from "@opentrad/shared";
import * as yaml from "js-yaml";
import { SkillLoadError } from "./errors";

export interface LoadedSkill {
  manifest: SkillManifest;
  // promptTemplate 在 loader 阶段就读出来,避免 PromptComposer 反复 IO + 利于单测
  promptTemplate: string;
}

// 单个 skill 加载结果。skillDir 永远存在(便于上层定位失败位置)。
export type LoadResult =
  | { ok: true; skillDir: string; skill: LoadedSkill }
  | { ok: false; skillDir: string; error: SkillLoadError };

// 单 skill 加载。失败抛 SkillLoadError,调用方用 loadBuiltinSkills 拿 LoadResult 不抛。
export function loadFromDirectory(skillDir: string): LoadedSkill {
  const yamlPath = join(skillDir, "skill.yml");
  if (!existsSync(yamlPath)) {
    throw new SkillLoadError(`skill.yml not found in ${skillDir}`, skillDir);
  }

  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(yamlPath, "utf-8"));
  } catch (err) {
    throw new SkillLoadError(`yaml parse failed: ${yamlPath}`, skillDir, err);
  }

  let manifest: SkillManifest;
  try {
    manifest = SkillManifestSchema.parse(raw);
  } catch (err) {
    throw new SkillLoadError(`manifest schema validation failed: ${yamlPath}`, skillDir, err);
  }

  const promptPath = join(skillDir, manifest.promptTemplate);
  if (!existsSync(promptPath)) {
    throw new SkillLoadError(`prompt template not found: ${promptPath}`, skillDir);
  }

  let promptTemplate: string;
  try {
    promptTemplate = readFileSync(promptPath, "utf-8");
  } catch (err) {
    throw new SkillLoadError(`prompt template read failed: ${promptPath}`, skillDir, err);
  }

  return { manifest, promptTemplate };
}

// 扫描 skillsDir 下每个子目录,per-skill 加载;失败的 skill 标记 ok:false 不阻塞其他。
export function loadBuiltinSkills(skillsDir: string): LoadResult[] {
  if (!existsSync(skillsDir)) {
    throw new SkillLoadError(`builtin skills directory not found: ${skillsDir}`, skillsDir);
  }

  const entries = readdirSync(skillsDir);
  const results: LoadResult[] = [];

  for (const entry of entries) {
    const skillDir = join(skillsDir, entry);
    // 跳过非目录(.DS_Store、单文件、symlink 等)
    let isDir = false;
    try {
      isDir = statSync(skillDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    try {
      const skill = loadFromDirectory(skillDir);
      results.push({ ok: true, skillDir, skill });
    } catch (err) {
      const error =
        err instanceof SkillLoadError
          ? err
          : new SkillLoadError(`unexpected load error: ${entry}`, skillDir, err);
      results.push({ ok: false, skillDir, error });
    }
  }

  return results;
}

// 用户导入的 skill(M1 不暴露导入 UI,接口先就位)。
// dir 不存在时返回 [](首次启动用户目录还没建,不算错)。
export function loadUserSkills(userSkillsDir: string): LoadResult[] {
  if (!existsSync(userSkillsDir)) return [];
  return loadBuiltinSkills(userSkillsDir);
}
