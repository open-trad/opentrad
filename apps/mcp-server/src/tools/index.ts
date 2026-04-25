// Tool 注册框架（M1 #25）。OpenTradTool 接口扩展 MCP SDK 标准 Tool 定义，
// 加 OpenTrad 自己的 riskLevel + category 元数据。
//
// M1 范围：仅 echo（safe 类）。后续 M1 #26 加 draft_save / hs_code_lookup /
// session_get_metadata；M1 #27 加 browser_open / browser_read / browser_screenshot。

import type { z } from "zod";
import type { IpcBridgeClient } from "../ipc-bridge";

// 调用 tool.execute 时的上下文
export interface ToolContext {
  bridge: IpcBridgeClient;
  sessionId: string;
}

// MCP 协议返回的 content。M1 只用 text；后续 M1 #27 browser_screenshot 加 image。
export type ToolContent = { type: "text"; text: string };

export interface OpenTradTool {
  name: string;
  description: string;
  // zod schema 描述 input，会被 zodToJsonSchema 转成 MCP SDK 的 inputSchema
  inputSchema: z.ZodTypeAny;
  riskLevel: "safe" | "review" | "blocked";
  category: "browser" | "platform" | "drafts" | "utility";
  execute(input: unknown, ctx: ToolContext): Promise<ToolContent[]>;
}

// 工具集合：M1 仅 echo。新增工具时 import + 加进数组。
import { echoTool } from "./echo";

export const tools: OpenTradTool[] = [echoTool];

export function getToolByName(name: string): OpenTradTool | undefined {
  return tools.find((t) => t.name === name);
}
