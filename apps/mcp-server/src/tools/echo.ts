// echo tool（M1 #25）：最简 safe 工具，验证 mcp-server 端到端跑通。
// 不走 RiskGate（safe 不弹窗）；不调 IPC bridge RPC（纯 in-process）。
// 真实业务工具（draft_save / browser_*）在 M1 #26 / #27 加。

import { z } from "zod";
import type { OpenTradTool } from "./index";

const InputSchema = z.object({
  message: z.string().describe("要 echo 回去的字符串"),
});

export const echoTool: OpenTradTool = {
  name: "echo",
  description:
    "Echo back the input message. Useful for verifying the OpenTrad MCP server is reachable.",
  inputSchema: InputSchema,
  riskLevel: "safe",
  category: "utility",
  async execute(rawInput) {
    const input = InputSchema.parse(rawInput);
    return [{ type: "text", text: `OpenTrad echo: ${input.message}` }];
  },
};
