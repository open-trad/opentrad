// browser tools 测试(M1 #27):browser_open / browser_read / browser_screenshot 三 tool。
// 用 mock BrowserService(不真启 Chromium),验证 ctx 注入 + 输入校验 + 返回内容形态。

import type { BrowserService } from "@opentrad/browser-tools";
import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/tools";
import { browserOpenTool } from "../src/tools/browser/open";
import { browserReadTool } from "../src/tools/browser/read";
import { browserScreenshotTool } from "../src/tools/browser/screenshot";

function makeCtxWithMockBrowser(impl: Partial<BrowserService>): ToolContext {
  return {
    bridge: {} as ToolContext["bridge"],
    sessionId: "test-session",
    browserService: impl as unknown as BrowserService,
  };
}

describe("browser_open", () => {
  it("调 newPage(url) 返回 pageId / title / url JSON 字符串", async () => {
    const newPage = vi.fn().mockResolvedValue({
      pageId: "pid-123",
      title: "Example",
      url: "https://example.com/",
    });
    const ctx = makeCtxWithMockBrowser({ newPage });

    const result = await browserOpenTool.execute({ url: "https://example.com/" }, ctx);
    expect(newPage).toHaveBeenCalledWith("https://example.com/");
    expect(result[0]?.type).toBe("text");
    if (result[0]?.type === "text") {
      const parsed = JSON.parse(result[0].text);
      expect(parsed).toEqual({
        pageId: "pid-123",
        title: "Example",
        url: "https://example.com/",
      });
    }
  });

  it("zod 校验:非 URL 字符串抛错", async () => {
    const ctx = makeCtxWithMockBrowser({ newPage: vi.fn() });
    await expect(browserOpenTool.execute({ url: "not-a-url" }, ctx)).rejects.toThrow();
  });

  it("ctx.browserService 缺失抛 sentinel error", async () => {
    const ctx: ToolContext = {
      bridge: {} as ToolContext["bridge"],
      sessionId: "s",
    };
    await expect(browserOpenTool.execute({ url: "https://example.com/" }, ctx)).rejects.toThrow(
      /browserService is not available/,
    );
  });
});

describe("browser_read", () => {
  it("调 readPageText(pageId) 返回 text content", async () => {
    const readPageText = vi.fn().mockResolvedValue({
      snapshot: {} as never,
      text: "URL: https://x/\nTitle: X\n",
    });
    const ctx = makeCtxWithMockBrowser({ readPageText });

    const result = await browserReadTool.execute({ pageId: "pid-1" }, ctx);
    expect(readPageText).toHaveBeenCalledWith("pid-1");
    expect(result).toEqual([{ type: "text", text: "URL: https://x/\nTitle: X\n" }]);
  });

  it("zod 校验:缺 pageId 抛错", async () => {
    const ctx = makeCtxWithMockBrowser({ readPageText: vi.fn() });
    await expect(browserReadTool.execute({}, ctx)).rejects.toThrow();
  });
});

describe("browser_screenshot", () => {
  it("调 screenshot(pageId) 返回 base64 PNG image content", async () => {
    const screenshot = vi.fn().mockResolvedValue({ pngBase64: "UE5HZmFrZQ==" });
    const ctx = makeCtxWithMockBrowser({ screenshot });

    const result = await browserScreenshotTool.execute({ pageId: "pid-1" }, ctx);
    expect(screenshot).toHaveBeenCalledWith("pid-1");
    expect(result).toEqual([{ type: "image", data: "UE5HZmFrZQ==", mimeType: "image/png" }]);
  });

  it("zod 校验:缺 pageId 抛错", async () => {
    const ctx = makeCtxWithMockBrowser({ screenshot: vi.fn() });
    await expect(browserScreenshotTool.execute({}, ctx)).rejects.toThrow();
  });
});
