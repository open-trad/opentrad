// Electron 主进程入口。对应 03-architecture.md §2 apps/desktop/src/main/index.ts。
// M0 范围：BrowserWindow、CCManager 单例、IPC handlers 注册、退出时清理。
// 不在本 issue 内：session 持久化（M2）、托盘/菜单、自动更新。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CCManager } from "@opentrad/cc-adapter";
import { app, BrowserWindow } from "electron";
import { registerIpcHandlers } from "./ipc";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 全局 CCManager 单例：所有 IPC handler 共享同一个 manager 以维持 activeTasks map。
const ccManager = new CCManager();

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

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}

app.whenReady().then(() => {
  registerIpcHandlers(ccManager);
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

// 应用退出前清理 CC 子进程（避免 claude 残留）。
// CCManager 内部也注册了 SIGINT/SIGTERM/exit handler，这里是业务层再加一道保险。
app.on("before-quit", async (event) => {
  if (ccManager.activeTasks.size === 0) return;
  event.preventDefault();
  await ccManager.cleanup();
  app.quit();
});
