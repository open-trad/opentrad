// BrowserService:Playwright Chromium 单例 + page lifecycle 管理。
//
// 03 ADR-007 + D-pre-1(bundle Chromium):dev 模式用 npm 默认 cache(发起人首次跑
// `pnpm --filter @opentrad/browser-tools setup`),packaged 模式 PLAYWRIGHT_BROWSERS_PATH
// env 由 desktop 主进程注入指向 .app/Resources/playwright/(M1 #30 落地)。
//
// 设计选择:
// - 单例懒加载:首次调 launch / newPage 时才启 Chromium(避免 mcp-server 启动卡顿)
// - launcher 注入(BrowserLauncher interface):单测 fake 不真启 Chromium,CI 不需 ~150MB binary
// - cleanup:应用退出时调,关闭所有 page + browser(避免僵尸进程)

import { randomUUID } from "node:crypto";
import { type DomSnapshot, extractDomSnapshot, snapshotToText } from "./dom-snapshot";
import type { BrowserHandle, BrowserLauncher, PageHandle } from "./types";

export interface BrowserServiceOptions {
  // 默认 dynamic import("playwright").chromium;单测注入 fake。
  launcher?: BrowserLauncher;
  // launch 时传给 playwright 的 options(headless 等)
  launchOptions?: { headless?: boolean };
}

export interface NewPageResult {
  pageId: string;
  title: string;
  url: string;
}

const SCREENSHOT_VIEWPORT = { width: 1280, height: 720 } as const;

export class BrowserService {
  private browser: BrowserHandle | undefined;
  private readonly pages = new Map<string, PageHandle>();
  private readonly launcher: BrowserLauncher | "lazy";
  private readonly launchOptions: { headless?: boolean };
  // 并发 launch 时的 in-flight promise,避免重复启动 Chromium
  private launchPromise: Promise<BrowserHandle> | undefined;

  constructor(opts: BrowserServiceOptions = {}) {
    // "lazy" sentinel:真用时才 dynamic import playwright,避免单测时 transitive 加载 playwright
    this.launcher = opts.launcher ?? "lazy";
    this.launchOptions = opts.launchOptions ?? { headless: false };
  }

  // 显式启动(可选,首次 newPage 也会自动启)
  async launch(): Promise<void> {
    await this.ensureBrowser();
  }

  async newPage(url?: string): Promise<NewPageResult> {
    const browser = await this.ensureBrowser();
    const page = await browser.newPage();
    if (url) {
      await page.goto(url, { timeout: 30_000 });
    }
    const pageId = randomUUID();
    this.pages.set(pageId, page);
    return {
      pageId,
      title: await page.title(),
      url: url ?? "",
    };
  }

  // 内部使用;tools 通过 readPageText / screenshot 调
  getPage(pageId: string): PageHandle | undefined {
    return this.pages.get(pageId);
  }

  async readPageText(pageId: string): Promise<{ snapshot: DomSnapshot; text: string }> {
    const page = this.requirePage(pageId);
    const snapshot = await page.evaluate<DomSnapshot>(extractDomSnapshot);
    const text = snapshotToText(snapshot);
    return { snapshot, text };
  }

  async screenshot(pageId: string): Promise<{ pngBase64: string }> {
    const page = this.requirePage(pageId);
    await page.setViewportSize(SCREENSHOT_VIEWPORT);
    const buffer = await page.screenshot({ type: "png" });
    return { pngBase64: buffer.toString("base64") };
  }

  async closePage(pageId: string): Promise<void> {
    const page = this.pages.get(pageId);
    if (!page) return;
    this.pages.delete(pageId);
    try {
      await page.close();
    } catch {
      // 已关闭 / 进程退出等忽略
    }
  }

  // 应用退出时调:关闭所有 page + browser。
  // 错误吞掉:cleanup 路径上 throw 会阻塞 app.before-quit。
  async cleanup(): Promise<void> {
    const pageIds = Array.from(this.pages.keys());
    for (const id of pageIds) {
      try {
        await this.closePage(id);
      } catch {}
    }
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = undefined;
    }
    this.launchPromise = undefined;
  }

  private requirePage(pageId: string): PageHandle {
    const page = this.pages.get(pageId);
    if (!page) {
      throw new Error(`page not found: ${pageId}`);
    }
    return page;
  }

  private async ensureBrowser(): Promise<BrowserHandle> {
    if (this.browser) return this.browser;
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = this.doLaunch();
    try {
      this.browser = await this.launchPromise;
      return this.browser;
    } finally {
      this.launchPromise = undefined;
    }
  }

  private async doLaunch(): Promise<BrowserHandle> {
    const launcher = await this.resolveLauncher();
    return launcher.launch(this.launchOptions);
  }

  private async resolveLauncher(): Promise<BrowserLauncher> {
    if (this.launcher !== "lazy") return this.launcher;
    // dynamic import 避免单测顶层加载 playwright;CI PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
    // 下 playwright npm 包仍可 import(只是没下 chromium binary,launch 真跑会抛)。
    const { chromium } = await import("playwright");
    return {
      async launch(opts) {
        return chromium.launch(opts) as unknown as BrowserHandle;
      },
    };
  }
}
