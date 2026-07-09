// connector:* IPC 协议（M0.5：bb-browser 选品站点连接器 + 预检）。
// 通道常量在 ../channels.ts。站点目录数据在 @opentrad/connectors（BB_SITES）。

import { z } from "zod";

// connector:status 响应：预检三态 + 每站点启用/需登录状态（供插件页渲染）
export interface ConnectorStatusResponse {
  // 预检
  cliInstalled: boolean;
  cliVersion: string | null;
  browserFound: boolean;
  daemonRunning: boolean;
  cdpConnected: boolean;
  ready: boolean;
  nextAction: "install-cli" | "install-browser" | "start-daemon" | "ready";
  // 每站点：id → 是否已启用（enabled 由用户在插件页开关，持久化）
  enabledSites: string[];
}

// connector:set-enabled 请求
export const ConnectorSetEnabledRequestSchema = z.object({
  siteId: z.string().min(1),
  enabled: z.boolean(),
});
export type ConnectorSetEnabledRequest = z.infer<typeof ConnectorSetEnabledRequestSchema>;

// connector:open-login 请求
export const ConnectorOpenLoginRequestSchema = z.object({
  siteId: z.string().min(1),
});
export type ConnectorOpenLoginRequest = z.infer<typeof ConnectorOpenLoginRequestSchema>;

// 一键动作的结果：友好三层信息（沿用 bb-browser 错误结构风格）
export interface ConnectorActionResult {
  ok: boolean;
  error?: string;
  hint?: string;
}
