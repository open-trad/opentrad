// Skill manifest 与输入字段定义。对应 03-architecture.md §4.3。

import { z } from "zod";

// skill manifest 里的一个输入字段定义（用于 UI 生成表单）。
export const SkillInputSchema = z.object({
  name: z.string(),
  type: z.enum(["text", "textarea", "select", "url", "file"]),
  label: z.string(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(), // 仅 type=select 时使用
  default: z.string().optional(),
});

export type SkillInput = z.infer<typeof SkillInputSchema>;

// skill 的完整 manifest（对应 skill.yml 文件解析后的结构）。
export const SkillManifestSchema = z.object({
  id: z.string(),
  title: z.string(),
  version: z.string(),
  description: z.string(),
  category: z.enum(["sourcing", "communication", "listing", "compliance", "other"]),
  riskLevel: z.enum(["draft_only", "read_only", "interactive"]),
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()).optional(),
  stopBefore: z.array(z.string()).optional(), // 业务级停止动作，Risk Gate 依赖
  inputs: z.array(SkillInputSchema),
  outputs: z.array(z.string()),
  promptTemplate: z.string(), // 相对 skill 目录的 markdown 文件路径
});

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
