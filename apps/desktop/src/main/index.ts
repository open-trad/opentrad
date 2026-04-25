// Electron 主进程入口。对应 03-architecture.md §2 apps/desktop/src/main/index.ts。
// M0 范围：BrowserWindow、CCManager 单例、IPC handlers 注册、退出时清理。
// M1 #19：SQLite 初始化、单实例互斥锁、session / settings / installed-skill IPC。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CCManager } from "@opentrad/cc-adapter";
import { app, BrowserWindow, dialog } from "electron";
import { registerIpcHandlers } from "./ipc";
import { createDbServices, type DbServices } from "./services/db";
import { type AppLock, AppLockHeldError, acquireAppLock } from "./services/lock";
import { PtyManager } from "./services/pty-manager";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 全局 CCManager 单例：所有 IPC handler 共享同一个 manager 以维持 activeTasks map。
const ccManager = new CCManager();

// 全局 PtyManager 单例：跨窗口共享，路由由 IPC handler 内部 ptyId → webContents 管理。
const ptyManager = new PtyManager();

// 启动时初始化、退出时释放：lock + db。
let appLock: AppLock | undefined;
let dbServices: DbServices | undefined;

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
  // 单实例互斥（M1 #19 验收 6）：另一个 OpenTrad 已运行时，提示后退出。
  try {
    appLock = acquireAppLock();
  } catch (err) {
    if (err instanceof AppLockHeldError) {
      dialog.showErrorBox(
        "OpenTrad 已在运行",
        `检测到另一个 OpenTrad 实例（PID=${err.heldByPid}）。请使用已打开的窗口。`,
      );
      app.quit();
      return;
    }
    throw err;
  }

  // SQLite 初始化（M1 #19 验收 1）：~/.opentrad/opentrad.db 自动建表。
  dbServices = createDbServices();

  registerIpcHandlers(ccManager, dbServices, ptyManager);
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

// 应用退出前清理 CC 子进程（避免 claude 残留）+ 关闭 db + 释放 lock。
// CCManager 内部也注册了 SIGINT/SIGTERM/exit handler，这里是业务层再加一道保险。
app.on("before-quit", async (event) => {
  if (ccManager.activeTasks.size > 0) {
    event.preventDefault();
    await ccManager.cleanup();
    finalizeShutdown();
    app.quit();
    return;
  }
  finalizeShutdown();
});

function finalizeShutdown(): void {
  try {
    ptyManager.cleanup();
  } catch (err) {
    console.error("[main] pty cleanup error", err);
  }
  try {
    dbServices?.close();
  } catch (err) {
    console.error("[main] db close error", err);
  }
  try {
    appLock?.release();
  } catch (err) {
    console.error("[main] lock release error", err);
  }
}
