// bb-browser daemon 生命周期 + 端口自愈（M0.5 修复：打包后"浏览器服务未能就绪"）。
//
// 根因（2026-07-09 发起人机器实机验证）：bb-browser daemon 默认走固定端口 9222，
// 若被用户常驻的调试 Chrome 占用（监听但不响应 CDP /json/version），daemon 起不来，
// 报误导性"浏览器服务未能就绪 / 端口被占用"。且失败的受管实例会留僵尸进程 + profile
// singleton 锁，导致后续启动被静默顶掉。
//
// 自愈流程（复刻主会话手动跑通的 workaround）：
// 1. 候选端口里若已有活的 CDP → 直接把 cdp-port 指向它
// 2. 否则清理僵尸受管 Chrome（持锁但 CDP 不响应）+ 删 Singleton 锁
// 3. 找空闲端口、用 bb-browser 同款参数 spawn 受管 Chrome、poll CDP 就绪、写 cdp-port
//
// 纯本地：只 spawn 本机 Chrome + 探测 127.0.0.1 CDP，无网络无后端。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const BB_HOME = join(homedir(), ".bb-browser", "browser");
const USER_DATA_DIR = join(BB_HOME, "user-data");
const CDP_PORT_FILE = join(BB_HOME, "cdp-port");
const CANDIDATE_PORTS = [9222, 9223, 9224, 9225, 9226];

// 受管 Chrome 启动参数（与 bb-browser 内部一致）
function managedChromeArgs(port: number): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "about:blank",
  ];
}

// 探测某端口是否有活的 CDP（/json/version 返回 200）
async function cdpAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1200),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// 端口是否被任意进程监听（TCP connect 成功即被占）
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(800, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// 清理僵尸受管 Chrome（持有 profile 锁但 CDP 不响应）+ 删 Singleton 锁
async function killZombieManaged(): Promise<void> {
  await new Promise<void>((resolve) => {
    const p = spawn("pkill", ["-9", "-f", "user-data-dir=.*\\.bb-browser"], { stdio: "ignore" });
    p.on("close", () => resolve());
    p.on("error", () => resolve());
  });
  for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    const f = join(USER_DATA_DIR, lock);
    if (!existsSync(f)) continue;
    await new Promise<void>((resolve) => {
      const p = spawn("rm", ["-f", f], { stdio: "ignore" });
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
  }
}

// spawn 受管 Chrome，等 CDP 就绪（最长 ~8s）
async function launchManagedChrome(chromePath: string, port: number): Promise<boolean> {
  try {
    mkdirSync(USER_DATA_DIR, { recursive: true });
  } catch {}
  try {
    const child = spawn(chromePath, managedChromeArgs(port), { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    return false;
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await cdpAlive(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export interface DaemonHealResult {
  ok: boolean;
  port?: number;
  error?: string;
  hint?: string;
}

// 确保有一个活的 CDP 端点，并把 cdp-port 文件指向它（供 bb-browser daemon start 发现）。
// chromePath 为 null 时无法自建受管实例（无浏览器）。
export async function ensureManagedCdp(chromePath: string | null): Promise<DaemonHealResult> {
  // 1. 候选端口里已有活 CDP → 直接用
  for (const port of CANDIDATE_PORTS) {
    if (await cdpAlive(port)) {
      writeCdpPort(port);
      return { ok: true, port };
    }
  }
  if (!chromePath) {
    return {
      ok: false,
      error: "未找到 Chromium 系浏览器",
      hint: "请安装 Chrome / Edge / Brave 后重试",
    };
  }
  // 2. 有端口被占但无活 CDP（僵尸）→ 清理
  let anyOccupied = false;
  for (const port of CANDIDATE_PORTS) {
    if (await portInUse(port)) {
      anyOccupied = true;
      break;
    }
  }
  if (anyOccupied) await killZombieManaged();

  // 3. 找空闲端口，spawn 受管 Chrome
  for (const port of CANDIDATE_PORTS) {
    if (await portInUse(port)) continue;
    if (await launchManagedChrome(chromePath, port)) {
      writeCdpPort(port);
      return { ok: true, port };
    }
  }
  return {
    ok: false,
    error: "浏览器服务未能就绪",
    hint: "候选端口（9222-9226）均无法建立浏览器调试连接。可关闭其它 Chrome 后重试，或重启应用",
  };
}

function writeCdpPort(port: number): void {
  try {
    mkdirSync(BB_HOME, { recursive: true });
    writeFileSync(CDP_PORT_FILE, String(port), "utf8");
  } catch {}
}
