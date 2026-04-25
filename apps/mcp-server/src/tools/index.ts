// Tool 注册框架（M1 #25 起）。OpenTradTool 接口扩展 MCP SDK 标准 Tool 定义，
// 加 OpenTrad 自己的 riskLevel + category 元数据。
//
// M1 工具落地节奏：
//   - #25：echo（safe，验证 stdio MCP 链路）
//   - #26：draft_save / hs_code_lookup / session_get_metadata（safe-only,
//          走 IPC bridge）
//   - #27：browser_open / browser_read / browser_screenshot（review-level）

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

// 工具集合：新增工具时 import + 加进数组。
import { draftSaveTool } from "./draft-save";
import { echoTool } from "./echo";
import { hsCodeLookupTool } from "./hs-code-lookup";
import { sessionGetMetadataTool } from "./session-get-metadata";

export const tools: OpenTradTool[] = [
  echoTool,
  draftSaveTool,
  hsCodeLookupTool,
  sessionGetMetadataTool,
];

export function getToolByName(name: string): OpenTradTool | undefined {
  return tools.find((t) => t.name === name);
}
