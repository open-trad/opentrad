// BrowserLauncher / BrowserHandle / PageHandle:Playwright 接口的 minimal 子集。
//
// 单测注入 fake 实现避免真启 Chromium(CI 不下载 binary)。生产用 playwright 的
// chromium 实例,运行时鸭子类型兼容(playwright Browser/Page 实际方法集合是这些 minimal
// 接口的超集)。
//
// 这里不依赖 playwright 类型 import,避免 CI 在 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
// 下可能出现的 transitive 类型问题。

export interface LaunchOptions {
  headless?: boolean;
  // 后续按需扩展:slowMo / args / executablePath / timeout
}

export interface BrowserLauncher {
  launch(opts?: LaunchOptions): Promise<BrowserHandle>;
}

export interface BrowserHandle {
  newPage(): Promise<PageHandle>;
  close(): Promise<void>;
}

export interface PageHandle {
  goto(url: string, opts?: { timeout?: number }): Promise<unknown>;
  title(): Promise<string>;
  // evaluate fn 序列化到 browser context 跑;arg 是可选传参。
  // 单测时 fake page 直接 stub 返回值,fn 不会真跑,document 在测试不存在 OK。
  evaluate<R>(fn: (...args: unknown[]) => R | Promise<R>, arg?: unknown): Promise<R>;
  screenshot(opts?: ScreenshotOptions): Promise<Buffer>;
  setViewportSize(size: { width: number; height: number }): Promise<unknown>;
  close(): Promise<void>;
}

export interface ScreenshotOptions {
  type?: "png" | "jpeg";
  fullPage?: boolean;
}
