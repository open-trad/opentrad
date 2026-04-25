// PromptComposer:把 SkillManifest + 用户 inputs 拼成最终交给 CC 的 prompt。
//
// 03-architecture.md §4.3 PromptComposer。issue M1 #6 (#23) 决策点 D-M1-2:
// - 不支持嵌套 mustache(M1 简化,M2 视需求加)
// - 必填 input 缺失抛 ValidationError
// - {{x}} 缺值时替换为空串(M1 简化;M2 视交互需要收紧为抛错或 UI 警告)

import { ValidationError } from "./errors";
import type { LoadedSkill } from "./loader";

// 通用前缀:每个 skill 运行前都注入,提示 CC 在该 skill scope 内行动。
// 03 §4.3:`You are operating within OpenTrad's <skillId> skill. <description>. Stay within scope.`
function buildPrefix(skill: LoadedSkill): string {
  const { manifest } = skill;
  return `You are operating within OpenTrad's ${manifest.id} skill. ${manifest.description}. Stay within scope.\n\n`;
}

// 函数式主接口。stateless(M1 不需要可配置前缀;M2 用户自定义前缀时再升级到 instance class)。
export function compose(skill: LoadedSkill, inputs: Record<string, unknown>): string {
  const { manifest, promptTemplate } = skill;

  // 必填字段校验
  for (const input of manifest.inputs) {
    if (input.required && !(input.name in inputs)) {
      throw new ValidationError(`missing required input: ${input.name}`);
    }
  }

  // mustache 替换 {{varName}}(无嵌套支持)
  const filled = promptTemplate.replace(/\{\{(\w+)\}\}/g, (_, varName) => {
    const v = inputs[varName];
    return v === undefined || v === null ? "" : String(v);
  });

  return buildPrefix(skill) + filled;
}

// PromptComposer namespace(对齐 03 §4.3 命名)。biome 拒纯静态 class,用 const 对象等价。
export const PromptComposer = { compose } as const;
