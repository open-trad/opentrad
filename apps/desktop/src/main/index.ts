// Electron 主进程入口。对应 03-architecture.md §2 apps/desktop/src/main/index.ts。
// M0 范围：创建 BrowserWindow、加载 renderer、退出时清理。
// 不在本 issue 内：IPC handlers（#7）、CC 集成（#8）、托盘/菜单（后续里程碑）。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const __dirname = dirname(fileURLToPath(import.meta.url));

// contextIsolation + sandbox 按 03-architecture.md §9「沙箱和权限」开启。
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "OpenTrad",
    show: false, // 等 ready-to-show 避免白屏闪烁
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  // 开发模式 electron-vite 注入 ELECTRON_RENDERER_URL；生产模式读打包后的 HTML 文件。
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}

app.whenReady().then(() => {
  createMainWindow();

  // macOS 点 dock icon 重启窗口（Electron 推荐行为）
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

// 非 macOS：关闭所有窗口 = 退出应用
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
