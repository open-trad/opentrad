// Electron 主进程入口。对应 03-architecture.md §2 apps/desktop/src/main/index.ts。
// M0 范围：BrowserWindow、CCManager 单例、IPC handlers 注册、退出时清理。
// M1 #19：SQLite 初始化、单实例互斥锁、session / settings / installed-skill IPC。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CCManager, redactEmail } from "@opentrad/cc-adapter";
import { loadFromDirectory } from "@opentrad/skill-runtime";
import { app, BrowserWindow, dialog, safeStorage } from "electron";
import { registerIpcHandlers } from "./ipc";
import { AgentService } from "./services/agent-service";
import { DetectLoopRegistry } from "./services/cc-detect-loop";
import { ConnectorService } from "./services/connector-service";
import { SafeStorageCredentialStore } from "./services/credential-store";
import { createDbServices, type DbServices, getIpcSocketPath, getUserDataDir } from "./services/db";
import { createDesktopRuntime } from "./services/desktop-runtime";
import {
  createHermesCommandRunner,
  HERMES_COMMAND_MAX_TIMEOUT_MS,
} from "./services/hermes/command-runner";
import { createHermesDockerPreflight } from "./services/hermes/docker-preflight";
import { resolveHermesNetworkEnvironment } from "./services/hermes/network-environment";
import type { HermesOAuthPtyCoordinator } from "./services/hermes/oauth-login";
import { createHermesProfileHomeDeleter } from "./services/hermes/profile-home";
import { resolveHermesLauncherPath } from "./services/hermes/resource-paths";
import { createHermesRuntimeInstallProgressBroadcaster } from "./services/hermes/runtime-install-progress";
import { HermesRuntimeInstaller } from "./services/hermes/runtime-installer";
import { HermesInteractionPrompter } from "./services/hermes-interaction-prompter";
import { createIpcBridgeHandlers } from "./services/ipc-bridge-handlers";
import { IpcBridgeServer } from "./services/ipc-bridge-server";
import { type AppLock, AppLockHeldError, acquireAppLock } from "./services/lock";
import { McpConfigWriter } from "./services/mcp-writer";
import { PtyManager } from "./services/pty-manager";
import { createRiskGate, type RiskGateBundle, type SkillContext } from "./services/risk-gate";
import { createShutdownCoordinator } from "./services/shutdown-coordinator";
import { validateWorkspaceRoot } from "./services/workspace-root";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 应用图标（build/icon.png）。dev 从源码树取，打包后 electron-builder 会用 build/icon.*
// 作为应用图标（无需运行时引用），这里主要给 dev 的 dock/window 用。
const APP_ICON_PATH = join(__dirname, "..", "..", "build", "icon.png");

// 全局 CCManager 单例：所有 IPC handler 共享同一个 manager 以维持 activeTasks map。
const ccManager = new CCManager({ installExitHandlers: false });

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
// M0 spike（重启方向）：自建 agent loop 的服务与 safeStorage 凭证仓
let agentService: AgentService | undefined;
let hermesOAuthCoordinator: HermesOAuthPtyCoordinator | undefined;
let hermesInteractionPrompter: HermesInteractionPrompter | undefined;
let credentialStore: SafeStorageCredentialStore | undefined;
// M0.5：bb-browser 选品连接器服务
let connectorService: ConnectorService | undefined;
// 主窗口引用,RiskGate UserPrompter 通过 getMainWindow getter 拿
let mainWindow: BrowserWindow | undefined;
const shutdownCoordinator = createShutdownCoordinator({
  cleanup: performShutdown,
  exit: (code) => app.exit(code),
  onCleanupError: (error, trigger) => {
    console.error(`[main] shutdown cleanup failed (${trigger})`, error);
  },
});

// contextIsolation + sandbox 按 03-architecture.md §9「沙箱和权限」开启。
function createMainWindow(): BrowserWindow | undefined {
  if (!shutdownCoordinator.canCreateMainWindow()) return undefined;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "OpenTrad",
    icon: APP_ICON_PATH, // Linux/Windows 窗口图标；macOS dock 图标见 app.dock.setIcon
    show: false, // 等 ready-to-show 避免白屏闪烁
    // macOS：隐藏标题栏、红绿灯浮在内容上（融入侧栏顶部，去网页套壳感）。
    // 侧栏顶部留出安全区并设为可拖拽（见 renderer AppShell 的 drag region）。
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 18 } }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => {
    if (shutdownCoordinator.canCreateMainWindow()) win.show();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  win.on("close", () => {
    void shutdownCoordinator.requestShutdown("window-close");
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
    // 清 RiskGate pending prompts(回 deny + reason='renderer_destroyed')
    riskGateBundle?.prompter.cleanupAll();
    hermesInteractionPrompter?.cleanupAll();
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

app.whenReady().then(async () => {
  // macOS dock 图标（dev 模式；打包后由 electron-builder 设置）。失败静默。
  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(APP_ICON_PATH);
    } catch {}
  }

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

  // M0 spike：safeStorage 凭证仓 + AgentService（自建 loop 会话管理，
  // 审批钩子桥接上面的 riskGateBundle.gate——与 CC 通道共用同一套规则/审计/弹窗）。
  credentialStore = new SafeStorageCredentialStore(dbServices.db, safeStorage);
  hermesInteractionPrompter = new HermesInteractionPrompter(() => mainWindow ?? null);
  const dataRoot = getUserDataDir();
  const deleteProfileHome = createHermesProfileHomeDeleter({
    dataRoot,
    platform: hostHermesPlatform(),
  });
  const profileHomeRecovery = await deleteProfileHome.recover(
    dbServices.providerProfiles.listRaw(),
  );
  const hermesNetworkEnvironment = resolveHermesNetworkEnvironment();
  const runtimeCommandEnvironment = Object.freeze({
    ...installerEnvironment(process.env),
    ...hermesNetworkEnvironment,
  });
  const installer = new HermesRuntimeInstaller({
    dataRoot,
    resourcesRoot: app.isPackaged
      ? join(process.resourcesPath, "hermes")
      : join(app.getAppPath(), "resources", "hermes"),
    runner: createHermesCommandRunner({
      cwd: dataRoot,
      env: runtimeCommandEnvironment,
      timeoutMs: HERMES_COMMAND_MAX_TIMEOUT_MS,
    }),
  });
  const validateExecutionBackend = createHermesDockerPreflight({
    runner: createHermesCommandRunner({
      cwd: dataRoot,
      env: runtimeCommandEnvironment,
    }),
  });
  const broadcastHermesRuntimeInstallProgress = createHermesRuntimeInstallProgressBroadcaster(() =>
    BrowserWindow.getAllWindows(),
  );
  const runtime = createDesktopRuntime({
    envRuntime: process.env.OPENTRAD_RUNTIME,
    dataRoot,
    launcherPath: resolveHermesLauncherPath(
      app.isPackaged
        ? { mode: "packaged", resourcesPath: process.resourcesPath }
        : { mode: "development", appPath: app.getAppPath() },
      hostHermesPlatform(),
    ),
    listProfiles: () => dbServices?.providerProfiles.listRaw() ?? [],
    credentials: credentialStore,
    installer,
    onInstallProgress: broadcastHermesRuntimeInstallProgress,
    networkEnvironment: hermesNetworkEnvironment,
  });
  agentService = new AgentService({
    profiles: dbServices.providerProfiles,
    agentEvents: dbServices.agentEvents,
    agentSessions: dbServices.agentSessions,
    agentRuntimeBindings: dbServices.agentRuntimeBindings,
    credentials: credentialStore,
    gate: riskGateBundle.gate,
    hermesInteractionPrompter,
    deleteProfileHome,
    initiallyBlockedProfileIds: profileHomeRecovery.blockedProfileIds,
    invalidateOAuthProfile: async (profileId) => {
      const coordinator = hermesOAuthCoordinator;
      if (!coordinator) throw new Error("Hermes OAuth coordinator is unavailable");
      await coordinator.invalidateProfile(profileId);
    },
    ...(runtime ? { runtime, validateWorkspaceRoot, validateExecutionBackend } : {}),
  });
  // M0.5：bb-browser 选品连接器服务（预检 + 启用站点持久化）
  connectorService = new ConnectorService(dbServices.settings);

  registerIpcHandlers({
    manager: ccManager,
    db: dbServices,
    pty: ptyManager,
    mcpWriter,
    detectLoop: detectLoopRegistry,
    riskGatePrompter: riskGateBundle.prompter,
    agent: agentService,
    connector: connectorService,
    hermesRuntime: runtime,
    hermesDataRoot: dataRoot,
    hermesPlatform: hostHermesPlatform(),
    hermesNetworkEnvironment,
    onHermesOAuthCoordinator: (coordinator) => {
      hermesOAuthCoordinator = coordinator;
    },
  });
  mainWindow = createMainWindow();

  // macOS 点 dock icon 重启窗口（Electron 推荐行为）
  app.on("activate", () => {
    if (shutdownCoordinator.canCreateMainWindow() && BrowserWindow.getAllWindows().length === 0) {
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

// 所有退出入口共用一个幂等协调器。cleanup 完成后直接 app.exit，避免再次触发
// before-quit 并在窗口关闭、系统信号并发到达时重复释放资源。
app.on("before-quit", (event) => {
  event.preventDefault();
  void shutdownCoordinator.requestShutdown("before-quit");
});

process.once("SIGINT", () => {
  void shutdownCoordinator.requestShutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdownCoordinator.requestShutdown("SIGTERM");
});

async function performShutdown(): Promise<void> {
  try {
    if (ccManager.activeTasks.size > 0) {
      await ccManager.cleanup();
    }
  } catch (err) {
    console.error("[main] CC cleanup error", err);
  }
  // Hermes session.close and Sidecar termination must finish before SQLite is closed.
  try {
    await agentService?.disposeAll();
  } catch (err) {
    console.error("[main] agent service dispose error", err);
  }
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
  try {
    await ipcBridgeServer?.stop();
  } catch (err) {
    console.error("[main] ipc-bridge stop error", err);
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

function hostHermesPlatform(): "darwin" | "linux" | "win32" {
  if (process.platform === "win32") return "win32";
  if (process.platform === "linux") return "linux";
  return "darwin";
}

function installerEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const) {
    const value = source[key];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      !value.includes("\0") &&
      !value.includes("\n") &&
      !value.includes("\r")
    ) {
      result[key] = value;
    }
  }
  return result;
}
