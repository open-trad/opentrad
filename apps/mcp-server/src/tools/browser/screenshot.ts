// browser_screenshot(M1 #27):返回 base64 PNG。viewport 锁 1280x720 避免巨大图。
// riskLevel='review':同 browser_open / browser_read。

import { z } from "zod";
import type { OpenTradTool } from "../index";

const InputSchema = z.object({
  pageId: z.string().describe("由 browser_open 返回的 pageId"),
});

export const browserScreenshotTool: OpenTradTool = {
  name: "browser_screenshot",
  description:
    "Capture a 1280x720 PNG screenshot of an opened page. Returns base64-encoded image content.",
  inputSchema: InputSchema,
  riskLevel: "review",
  category: "browser",
  async execute(rawInput, ctx) {
    const input = InputSchema.parse(rawInput);
    if (!ctx.browserService) {
      throw new Error("browserService is not available in this context (mcp-server bug)");
    }
    const { pngBase64 } = await ctx.browserService.screenshot(input.pageId);
    return [{ type: "image", data: pngBase64, mimeType: "image/png" }];
  },
};
