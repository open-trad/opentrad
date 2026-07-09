// BrowserService 测试:用 fake launcher / browser / page,不真启 Chromium。
// 单测覆盖 lifecycle (launch / newPage / close / cleanup) + readPageText + screenshot
// + 错误路径(pageId not found)+ 并发 launch 不重复启动。

import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserService } from "../src/browser-service";
import type { DomSnapshot } from "../src/dom-snapshot";
import type { BrowserHandle, BrowserLauncher, PageHandle } from "../src/types";

interface FakePage extends PageHandle {
  closed: boolean;
}

function makeFakePage(opts?: {
  title?: string;
  snapshot?: DomSnapshot;
  screenshotBuffer?: Buffer;
}): FakePage {
  const snapshot: DomSnapshot = opts?.snapshot ?? {
    title: "Mock Title",
    url: "https://mock.example/",
    headings: [{ level: 1, text: "Hello" }],
    visibleText: "Mock body text",
    links: [{ href: "https://mock.example/a", text: "A" }],
  };
  const screenshotBuffer = opts?.screenshotBuffer ?? Buffer.from("PNGFAKE");
  const page: FakePage = {
    closed: false,
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue(opts?.title ?? snapshot.title),
    evaluate: vi.fn().mockResolvedValue(snapshot) as PageHandle["evaluate"],
    screenshot: vi.fn().mockResolvedValue(screenshotBuffer),
    setViewportSize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockImplementation(async () => {
      page.closed = true;
    }),
  };
  return page;
}

interface FakeBrowser extends BrowserHandle {
  closed: boolean;
  pages: FakePage[];
}

function makeFakeBrowser(): FakeBrowser {
  const browser: FakeBrowser = {
    closed: false,
    pages: [],
    newPage: vi.fn().mockImplementation(async () => {
      const p = makeFakePage();
      browser.pages.push(p);
      return p;
    }),
    close: vi.fn().mockImplementation(async () => {
      browser.closed = true;
    }),
  };
  return browser;
}

function makeFakeLauncher(browser: FakeBrowser): BrowserLauncher & { launchCount: number } {
  let count = 0;
  return {
    get launchCount() {
      return count;
    },
    async launch() {
      count++;
      return browser;
    },
  };
}

describe("BrowserService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("launch 启动 browser(单例,二次调用不重复 launch)", async () => {
    const browser = makeFakeBrowser();
    const launcher = makeFakeLauncher(browser);
    const svc = new BrowserService({ launcher });

    await svc.launch();
    await svc.launch();

    expect(launcher.launchCount).toBe(1);
  });

  it("newPage 自动 launch + 返回 pageId / title / url", async () => {
    const browser = makeFakeBrowser();
    const launcher = makeFakeLauncher(browser);
    const svc = new BrowserService({ launcher });

    const result = await svc.newPage("https://example.com/");

    expect(result.pageId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.title).toBe("Mock Title");
    expect(result.url).toBe("https://example.com/");
    expect(browser.pages).toHaveLength(1);
    expect(browser.pages[0]?.goto).toHaveBeenCalledWith("https://example.com/", {
      timeout: 30_000,
    });
  });

  it("readPageText 返回 snapshot + 序列化文本", async () => {
    const browser = makeFakeBrowser();
    const launcher = makeFakeLauncher(browser);
    const svc = new BrowserService({ launcher });

    const { pageId } = await svc.newPage("https://example.com/");
    const { snapshot, text } = await svc.readPageText(pageId);

    expect(snapshot.title).toBe("Mock Title");
    expect(text).toContain("URL: https://mock.example/");
    expect(text).toContain("Title: Mock Title");
    expect(text).toContain("# Hello");
    expect(text).toContain("Mock body text");
    expect(text).toContain("https://mock.example/a");
  });

  it("screenshot 锁定 viewport 1280x720 + 返回 base64 PNG", async () => {
    const browser = makeFakeBrowser();
    const launcher = makeFakeLauncher(browser);
    const svc = new BrowserService({ launcher });

    const { pageId } = await svc.newPage("https://example.com/");
    const { pngBase64 } = await svc.screenshot(pageId);

    const page = browser.pages[0];
    expect(page?.setViewportSize).toHaveBeenCalledWith({ width: 1280, height: 720 });
    expect(page?.screenshot).toHaveBeenCalledWith({ type: "png" });
    expect(pngBase64).toBe(Buffer.from("PNGFAKE").toString("base64"));
  });

  it("readPageText / screenshot 找不到 pageId 抛错", async () => {
    const browser = makeFakeBrowser();
    const launcher = makeFakeLauncher(browser);
    const svc = new BrowserService({ launcher });
    await svc.launch();

    await expect(svc.readPageText("nonexistent")).rejects.toThrow(/page not found/);
    await expect(svc.screenshot("nonexistent")).rejects.toThrow(/page not found/);
  });

  it("closePage 移除 page 并调 page.close", async () => {
    const browser = makeFakeBrowser();
    const launcher = makeFakeLauncher(browser);
    const svc = new BrowserService({ launcher });

    const { pageId } = await svc.newPage("https://example.com/");
    await svc.closePage(pageId);

    const page = browser.pages[0] as FakePage;
    expect(page.closed).toBe(true);
    // 二次 close 不抛(已不在 map)
    await expect(svc.closePage(pageId)).resolves.toBeUndefined();
  });

  it("cleanup 关闭所有 page + browser", async () => {
    const browser = makeFakeBrowser();
    const launcher = makeFakeLauncher(browser);
    const svc = new BrowserService({ launcher });

    await svc.newPage("https://a.example/");
    await svc.newPage("https://b.example/");
    await svc.cleanup();

    expect(browser.closed).toBe(true);
    for (const p of browser.pages) {
      expect((p as FakePage).closed).toBe(true);
    }
  });

  it("并发 launch 共享 in-flight promise(不重复启动 Chromium)", async () => {
    const browser = makeFakeBrowser();
    const launcher = makeFakeLauncher(browser);
    const svc = new BrowserService({ launcher });

    // 三个并发 newPage,实际 launch 应只触发 1 次
    await Promise.all([
      svc.newPage("https://a.example/"),
      svc.newPage("https://b.example/"),
      svc.newPage("https://c.example/"),
    ]);

    expect(launcher.launchCount).toBe(1);
    expect(browser.pages).toHaveLength(3);
  });
});
