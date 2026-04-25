#!/usr/bin/env node
// 智能确保 better-sqlite3 binary 是当前 Electron 的 ABI（M1 PR A v2）。
//
// 背景：
// - better-sqlite3 是经典 ABI-bound 模块（不是 N-API），编译时绑死 NODE_MODULE_VERSION
// - pnpm install 默认走 prebuild-install / node-gyp，编出来是系统 Node ABI（137）
// - Electron 41.x 需要 ABI 145，binary 不匹配时 dlopen 报错
// - pnpm install 在 monorepo workspace already-up-to-date 时**跳过所有 install hook**
//   （实测：pnpm@10 行为），所以单纯依赖 postinstall 不可靠
// - electron-rebuild 不带 -f 会假成功（实测：报 Rebuild Complete 但 binary 不动）
//
// 修法：
// - 本脚本在 predev / postinstall 都跑
// - 用 sentinel 文件（apps/desktop/.electron-abi-sentinel.json）记录上次 rebuild 后的
//   binary 指纹（size + Electron version + abi）
// - 启动前 0 秒检查 sentinel 是否匹配；匹配跳过；不匹配才 spawn electron-rebuild -f
// - 99% 启动场景 0 秒开销，1% ABI 切换场景 1-2 秒 rebuild
//
// node-pty 是 N-API，ABI-agnostic，不参与本检查。

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..", "..");
const SENTINEL_PATH = path.join(DESKTOP_DIR, ".electron-abi-sentinel.json");

function findBetterSqliteBinary() {
  // pnpm content-addressable layout：node_modules/.pnpm/better-sqlite3@<ver>/...
  const pnpmDir = path.join(REPO_ROOT, "node_modules", ".pnpm");
  if (!fs.existsSync(pnpmDir)) return null;
  const entry = fs.readdirSync(pnpmDir).find((d) => d.startsWith("better-sqlite3@"));
  if (!entry) return null;
  const binary = path.join(
    pnpmDir,
    entry,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
  return fs.existsSync(binary) ? binary : null;
}

function getElectronInfo() {
  // 直接从 electron 包 dist 读 abi_version + package.json version
  const pnpmDir = path.join(REPO_ROOT, "node_modules", ".pnpm");
  if (!fs.existsSync(pnpmDir)) return null;
  const entry = fs.readdirSync(pnpmDir).find((d) => d.startsWith("electron@"));
  if (!entry) return null;
  const electronDir = path.join(pnpmDir, entry, "node_modules", "electron");
  let version, abi;
  try {
    version = JSON.parse(fs.readFileSync(path.join(electronDir, "package.json"), "utf-8")).version;
  } catch {
    return null;
  }
  try {
    abi = fs.readFileSync(path.join(electronDir, "abi_version"), "utf-8").trim();
  } catch {
    return null;
  }
  return { version, abi };
}

function readSentinel() {
  if (!fs.existsSync(SENTINEL_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(SENTINEL_PATH, "utf-8"));
  } catch {
    return null; // 损坏视为缺失
  }
}

function writeSentinel(record) {
  fs.writeFileSync(SENTINEL_PATH, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
}

function fingerprint() {
  const electron = getElectronInfo();
  const binary = findBetterSqliteBinary();
  if (!electron || !binary) return null;
  const stat = fs.statSync(binary);
  return {
    electron: electron.version,
    abi: electron.abi,
    betterSqliteSize: stat.size,
  };
}

function fingerprintsMatch(a, b) {
  if (!a || !b) return false;
  return a.electron === b.electron && a.abi === b.abi && a.betterSqliteSize === b.betterSqliteSize;
}

function rebuild() {
  console.log("[ensure-electron-abi] ABI fingerprint mismatch → running electron-rebuild -f");
  // Windows 上 spawn("pnpm") 需要 .cmd 后缀；用 shell:true 让 OS 自己解析。
  // 参数都是固定字符串无 escape 风险。
  const result = spawnSync(
    "pnpm",
    ["exec", "electron-rebuild", "-f", "-w", "better-sqlite3", "-w", "node-pty"],
    {
      cwd: DESKTOP_DIR,
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  if (result.status !== 0) {
    console.error(
      `[ensure-electron-abi] electron-rebuild failed (status=${result.status}, signal=${result.signal}, error=${result.error?.message ?? "none"})`,
    );
    process.exit(result.status ?? 1);
  }
}

function main() {
  const current = fingerprint();
  if (!current) {
    // node_modules 还没装齐（pnpm install 进行中等罕见时序）→ 不阻塞,让 pnpm install 完成
    console.log("[ensure-electron-abi] dependencies not ready, skipping");
    return;
  }

  const sentinel = readSentinel();
  if (fingerprintsMatch(sentinel, current)) {
    // 99% 路径：sentinel 已对齐，0 秒退出
    return;
  }

  rebuild();

  // rebuild 后重新拿指纹，写 sentinel
  const after = fingerprint();
  if (after) writeSentinel(after);
}

main();
