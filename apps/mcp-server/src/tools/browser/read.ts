// browser_read(M1 #27):读取 pageId 对应页面的简化 DOM snapshot。
// 返回 ≤5KB 文本(extractDomSnapshot 算法 + snapshotToText 序列化),给 LLM 看而不是整页 HTML。
// riskLevel='review':同 browser_open。

import { z } from "zod";
import type { OpenTradTool } from "../index";

const InputSchema = z.object({
  pageId: z.string().describe("由 browser_open 返回的 pageId"),
});

export const browserReadTool: OpenTradTool = {
  name: "browser_read",
  description:
    "Read a simplified DOM snapshot (title / headings / visible text / first 50 links) of an opened page. Returns ≤5KB markdown-ish text suitable for LLM consumption.",
  inputSchema: InputSchema,
  riskLevel: "review",
  category: "browser",
  async execute(rawInput, ctx) {
    const input = InputSchema.parse(rawInput);
    if (!ctx.browserService) {
      throw new Error("browserService is not available in this context (mcp-server bug)");
    }
    const { text } = await ctx.browserService.readPageText(input.pageId);
    return [{ type: "text", text }];
  },
};
