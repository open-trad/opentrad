# @opentrad/browser-tools

Playwright 封装,给 mcp-server 的 browser tools(`browser_open` / `browser_read` / `browser_screenshot`)用。M1 #27 落地点。

## Setup(dev 模式首次)

CI 跳过 Chromium 下载(`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`),dev 模式发起人首次需手动安装 Chromium binary:

```bash
pnpm --filter @opentrad/browser-tools setup
# 等价 npx playwright install chromium
```

约 150MB 下载,放在 `~/Library/Caches/ms-playwright/`(macOS)。

M1 #30 真打包时 electron-builder `extraResources` 把 Chromium 内置到 `.app/.exe/.AppImage` Resources/playwright/,运行时 `PLAYWRIGHT_BROWSERS_PATH` env 指向 bundled 路径(不依赖用户 setup)。M1 #27 这步先 bundle 进 dev cache 即可。

## API

```ts
import { BrowserService } from "@opentrad/browser-tools";

const svc = new BrowserService();
await svc.launch();
const { pageId, title } = await svc.newPage("https://example.com");
const text = await svc.readPageText(pageId);   // ≤5KB DOM snapshot
const png = await svc.screenshot(pageId);       // base64 PNG
await svc.cleanup();
```

## 测试策略

单测注入 fake launcher(`BrowserLauncher` interface),不真启 Chromium。`extractDomSnapshot` 是 serializable 命名函数,运行在 page context 内,单测时 evaluate 由 fake page 直接 stub 返回值。dev 模式 e2e 验证 launch + 真实页面交互。

## 退场计划

无:本包是 M1 起的常驻 lib,后续 skill 增加更多 browser 操作时在此扩展。
