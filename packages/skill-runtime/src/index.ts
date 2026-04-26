// @opentrad/skill-runtime 入口:loader / composer / errors。
// SkillManifest / SkillInput 类型在 @opentrad/shared,本包不重复定义,
// 但 re-export 方便业务包一行 import。

export type { SkillInput, SkillManifest } from "@opentrad/shared";
export { SkillInputSchema, SkillManifestSchema } from "@opentrad/shared";
export { compose, PromptComposer } from "./composer";
export { SkillLoadError, ValidationError } from "./errors";
export {
  type LoadedSkill,
  type LoadResult,
  loadBuiltinSkills,
  loadFromDirectory,
  loadUserSkills,
} from "./loader";
