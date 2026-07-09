// 连接器规范 v1（ADR-001）。
// 连接器 = 带凭证的外部数据/动作源（bb-browser 站点适配器组、shopify-admin 等）。
// 原则：
// - 用户自带凭证（BYO credentials），责任边界清晰；凭证经 safeStorage，manifest 只声明需要什么
// - 每个动作声明 riskLevel；对外副作用动作声明 stopBefore=true → Risk Gate 业务级强制确认
// - 与 skill 的分工：skill 是纯声明式 prompt 资产（不含代码）；带代码的扩展只有连接器一种形态

import { RiskLevelSchema } from "@opentrad/shared";
import { z } from "zod";

export const ConnectorAuthSchema = z.discriminatedUnion("type", [
  // 无凭证（如 bb-browser：复用用户浏览器登录态，凭证在浏览器里不在我们这）
  z.object({ type: z.literal("none") }),
  // API key / token：credentialRef 指向 safeStorage
  z.object({
    type: z.literal("api-key"),
    credentialRef: z.string(),
  }),
  // OAuth 应用凭证（M4 shopify-admin：token 自动刷新）
  z.object({
    type: z.literal("oauth"),
    credentialRef: z.string(),
  }),
]);
export type ConnectorAuth = z.infer<typeof ConnectorAuthSchema>;

export const ConnectorActionSchema = z.object({
  // 动作名（连接器内唯一）；注册到 tool-host 时命名空间化为 "<connectorId>.<name>"
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string(),
  // JSON Schema 或 zod 序列化产物；透传给模型作为工具参数 schema
  inputSchema: z.unknown(),
  riskLevel: RiskLevelSchema,
  // 业务级停止位：true 时该动作永远停在 Risk Gate 确认卡片前（如 publish_listing）
  stopBefore: z.boolean().default(false),
  // 业务动作标识，供审批卡片展示与审计分组
  businessAction: z.string().optional(),
});
export type ConnectorAction = z.infer<typeof ConnectorActionSchema>;

export const ConnectorManifestSchema = z.object({
  // 规范版本，向后兼容判断用
  specVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  displayName: z.string(),
  description: z.string(),
  auth: ConnectorAuthSchema,
  actions: z.array(ConnectorActionSchema).min(1),
});
export type ConnectorManifest = z.infer<typeof ConnectorManifestSchema>;

// 校验入口：解析失败抛 ZodError，调用方负责转用户可读错误
export function parseConnectorManifest(input: unknown): ConnectorManifest {
  const manifest = ConnectorManifestSchema.parse(input);
  const names = new Set<string>();
  for (const action of manifest.actions) {
    if (names.has(action.name)) {
      throw new Error(`connector ${manifest.id}: duplicate action name "${action.name}"`);
    }
    names.add(action.name);
    // 约束：stopBefore 动作必须声明 businessAction（审批卡片需要业务语义）
    if (action.stopBefore && !action.businessAction) {
      throw new Error(
        `connector ${manifest.id}: action "${action.name}" has stopBefore but no businessAction`,
      );
    }
  }
  return manifest;
}
