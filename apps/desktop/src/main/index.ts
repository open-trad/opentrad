// Electron 主进程入口。对应 03-architecture.md §2 apps/desktop/src/main/index.ts。
// M0 范围：BrowserWindow、CCManager 单例、IPC handlers 注册、退出时清理。
// M1 #19：SQLite 初始化、单实例互斥锁、session / settings / installed-skill IPC。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CCManager, redactEmail } from "@opentrad/cc-adapter";
import { loadFromDirectory } from "@opentrad/skill-runtime";
import { app, BrowserWindow, dialog } from "electron";
import { registerIpcHandlers } from "./ipc";
import { DetectLoopRegistry } from "./services/cc-detect-loop";
import { createDbServices, type DbServices, getIpcSocketPath } from "./services/db";
import { createIpcBridgeHandlers } from "./services/ipc-bridge-handlers";
import { IpcBridgeServer } from "./services/ipc-bridge-server";
import { type AppLock, AppLockHeldError, acquireAppLock } from "./services/lock";
import { McpConfigWriter } from "./services/mcp-writer";
import { PtyManager } from "./services/pty-manager";
import { createRiskGate, type RiskGateBundle, type SkillContext } from "./services/risk-gate";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 全局 CCManager 单例：所有 IPC handler 共享同一个 manager 以维持 activeTasks map。
const ccManager = new CCManager();

// 全局 PtyManager 单例：跨窗口共享，路由由 IPC handler 内部 ptyId → webContents 管理。
const ptyManager = new PtyManager();

// CC 安装状态后台轮询注册表（M1 #21）：onboarding 流程触发，每 webContents 一个 loop。
const detectLoopRegistry = new DetectLoopRegistry(ccManager, redactEmail);

// McpConfigWriter（M1 #26）：每次 startTask 生成临时 mcp-config，让 CC 通过 stdio
// 拉起 apps/mcp-server。dev 用 tsx 跑 .ts 入口；electron-builder 打包路径在 M1 #13。
// REPO_ROOT 从 main/index.ts 文件位置回溯：apps/desktop/src/main → 上 4 层。
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const mcpWriter = new McpConfigWriter({
  mcpServerCommand: join(REPO_ROOT, "node_modules", ".bin", "tsx"),
  mcpServerArgs: [join(REPO_ROOT, "apps", "mcp-server", "src", "index.ts")],
});

// 启动时初始化、退出时释放：lock + db + ipc-bridge server + risk-gate。
let appLock: AppLock | undefined;
let dbServices: DbServices | undefined;
let ipcBridgeServer: IpcBridgeServer | undefined;
let riskGateBundle: RiskGateBundle | undefined;
// 主窗口引用,RiskGate UserPrompter 通过 getMainWindow getter 拿
let mainWindow: BrowserWindow | undefined;

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

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
    // 清 RiskGate pending prompts(回 deny + reason='renderer_destroyed')
    riskGateBundle?.prompter.cleanupAll();
  });

  return win;
}

// SkillContext resolver:RiskGate 用 sessionId 查 db.sessions → skillId →
// loadFromDirectory(fixture)拿 stopBefore。失败 graceful degrade(D-M1-5):
// 返回 { skillId: null, stopBeforeList: [] },RiskGate 退化为纯工具级判断。
function resolveSkillContext(sessionId: string): SkillContext {
  if (!dbServices) return { skillId: null, stopBeforeList: [] };
  try {
    const session = dbServices.sessions.get(sessionId);
    if (!session) return { skillId: null, stopBeforeList: [] };
    const skillId = session.skillId;
    if (!skillId) return { skillId: null, stopBeforeList: [] };
    const fixtureDir = join(
      app.getAppPath(),
      "..",
      "..",
      "packages",
      "skill-runtime",
      "__fixtures__",
      skillId,
    );
    try {
      const loaded = loadFromDirectory(fixtureDir);
      return {
        skillId,
        stopBeforeList: loaded.manifest.stopBefore ?? [],
      };
    } catch {
      // skill 加载失败:返回 skillId 但无 stopBefore(audit_log 仍能记 skillId)
      return { skillId, stopBeforeList: [] };
    }
  } catch (err) {
    console.error("[risk-gate] resolveSkillContext failed", err);
    return { skillId: null, stopBeforeList: [] };
  }
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

  // RiskGate(M1 #28 阶段 2):RuleProvider/AuditLogger/UserPrompter 三 adapter +
  // 5min timeout(在 main UserPrompter 内,既 user-facing 也是 IPC bridge 兜底)。
  // mainWindow getter 让 prompter 拿到当前主窗口推 risk-gate:confirm channel。
  riskGateBundle = createRiskGate(dbServices, () => mainWindow ?? null, resolveSkillContext);

  // IPC bridge server（M1 #25 验收 1）：~/.opentrad/ipc.sock 文件创建（macOS/Linux）
  // / Windows named pipe 建立。mcp-server 子进程通过它调 4 个 RPC。
  // **M1 #28**:risk-gate.request handler 改用真实 RiskGate.check（mock 已替换）。
  // 启动失败不阻塞 app（mcp-server 端有 graceful degrade，echo 类 safe tool 仍可用）。
  ipcBridgeServer = new IpcBridgeServer({
    socketPath: getIpcSocketPath(),
    handlers: createIpcBridgeHandlers(dbServices, riskGateBundle),
  });
  ipcBridgeServer.start().catch((err) => {
    console.error("[main] IPC bridge server start failed", err);
  });

  registerIpcHandlers({
    manager: ccManager,
    db: dbServices,
    pty: ptyManager,
    mcpWriter,
    detectLoop: detectLoopRegistry,
    riskGatePrompter: riskGateBundle.prompter,
  });
  mainWindow = createMainWindow();

  // macOS 点 dock icon 重启窗口（Electron 推荐行为）
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
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
    detectLoopRegistry.cleanupAll();
  } catch (err) {
    console.error("[main] detect-loop cleanup error", err);
  }
  try {
    ptyManager.cleanup();
  } catch (err) {
    console.error("[main] pty cleanup error", err);
  }
  // IPC bridge server stop 是 async，但 finalizeShutdown 里同步调；
  // 用 .catch 保护，主进程已经在退出路径上，stop 失败也无所谓
  try {
    void ipcBridgeServer?.stop().catch((err) => {
      console.error("[main] ipc-bridge stop error", err);
    });
  } catch (err) {
    console.error("[main] ipc-bridge stop sync error", err);
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
