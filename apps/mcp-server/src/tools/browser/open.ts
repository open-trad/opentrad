// browser_open(M1 #27):打开 URL,返回 pageId 供后续 browser_read / browser_screenshot 调。
// riskLevel='review':真 RiskGate 弹窗在 M1 #28 替换 MockRiskGate;本 PR 用 MockRiskGate allow 所有。

import { z } from "zod";
import type { OpenTradTool } from "../index";

const InputSchema = z.object({
  url: z.string().url().describe("要打开的 URL,必须是有效 http(s) 地址"),
});

export const browserOpenTool: OpenTradTool = {
  name: "browser_open",
  description:
    "Open a URL in the managed Chromium browser. Returns { pageId, title, url } for follow-up browser_read / browser_screenshot calls.",
  inputSchema: InputSchema,
  riskLevel: "review",
  category: "browser",
  async execute(rawInput, ctx) {
    const input = InputSchema.parse(rawInput);
    if (!ctx.browserService) {
      throw new Error("browserService is not available in this context (mcp-server bug)");
    }
    const result = await ctx.browserService.newPage(input.url);
    return [
      {
        type: "text",
        text: JSON.stringify(
          { pageId: result.pageId, title: result.title, url: result.url },
          null,
          2,
        ),
      },
    ];
  },
};
