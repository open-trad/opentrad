// bb-browser 预检：CLI / 浏览器 / daemon 三项状态 + 一键启动。
//
// UI 插件页顶部状态条据此渲染绿勾/黄警 + 一键修复。所有函数永不抛异常。
// 实机故障模式（2026-07-09 发起人机器验证）：端口 9222 被非 CDP 监听占用 →
// bb-browser 报误导性"找不到浏览器"。startDaemon 走 `bb-browser daemon start`，
// 高级端口自愈（换端口/清僵尸锁）留作增强，先覆盖常规路径。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { type RunnerOptions, resolveBbBrowserPath, runBbBrowser } from "./runner";

export interface PreflightStatus {
  cliInstalled: boolean;
  cliVersion: string | null;
  browserFound: boolean;
  browserPath: string | null;
  daemonRunning: boolean;
  cdpConnected: boolean;
  // 综合判断：能否执行站点命令
  ready: boolean;
  // 当前最该做的一步（UI 状态条的主提示）
  nextAction: "install-cli" | "install-browser" | "start-daemon" | "ready";
}

// macOS Chromium 系浏览器固定路径（与 bb-browser 内部检测一致）
const DARWIN_BROWSERS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Arc.app/Contents/MacOS/Arc",
];

function findBrowser(): string | null {
  if (process.platform === "darwin") {
    return DARWIN_BROWSERS.find((p) => existsSync(p)) ?? null;
  }
  // 非 darwin：交给 bb-browser 自己检测，这里保守返回 null（不阻塞，daemon start 时会报）
  return null;
}

export async function checkPreflight(opts: RunnerOptions = {}): Promise<PreflightStatus> {
  // 1. CLI
  const versionResult = await runBbBrowser(["--version"], 5000, opts);
  const cliInstalled = versionResult.ok || !versionResult.error?.includes("未找到");
  const cliVersion =
    versionResult.ok && typeof versionResult.data === "string" ? versionResult.data.trim() : null;

  // 2. 浏览器
  const browserPath = findBrowser();

  // 3. daemon（status --json）
  const statusResult = await runBbBrowser(["status"], 5000, opts);
  let daemonRunning = false;
  let cdpConnected = false;
  if (statusResult.ok && statusResult.data && typeof statusResult.data === "object") {
    const d = statusResult.data as Record<string, unknown>;
    daemonRunning = d.running === true;
    cdpConnected = d.cdpConnected === true;
  }

  const browserFound = browserPath !== null;
  const ready = cliInstalled && daemonRunning && cdpConnected;
  let nextAction: PreflightStatus["nextAction"] = "ready";
  if (!cliInstalled) nextAction = "install-cli";
  else if (!browserFound) nextAction = "install-browser";
  else if (!ready) nextAction = "start-daemon";

  return {
    cliInstalled,
    cliVersion,
    browserFound,
    browserPath,
    daemonRunning,
    cdpConnected,
    ready,
    nextAction,
  };
}

// 一键启动浏览器服务（daemon）。返回启动后的预检状态。
// 走 `bb-browser daemon start`（内部会 launch 受管 Chrome）。
export async function startDaemon(opts: RunnerOptions = {}): Promise<PreflightStatus> {
  const cli = opts.cliPath ?? resolveBbBrowserPath();
  const spawnImpl = opts.spawnFn ?? spawn;
  await new Promise<void>((resolve) => {
    try {
      const child = spawnImpl(cli, ["daemon", "start"], { stdio: "ignore" });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    } catch {
      resolve();
    }
  });
  // 给 daemon 起来一点时间后复检
  return checkPreflight(opts);
}

// 在受管浏览器打开某站点登录页（用户登录一次即持久到受管 profile）。
export async function openSiteLogin(loginUrl: string, opts: RunnerOptions = {}): Promise<void> {
  const cli = opts.cliPath ?? resolveBbBrowserPath();
  const spawnImpl = opts.spawnFn ?? spawn;
  await new Promise<void>((resolve) => {
    try {
      const child = spawnImpl(cli, ["tab", "new", loginUrl], { stdio: "ignore" });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    } catch {
      resolve();
    }
  });
}
