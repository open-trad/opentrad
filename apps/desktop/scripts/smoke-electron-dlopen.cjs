#!/usr/bin/env node
// Electron 真 dlopen smoke test（M1 PR A v2 / open-trad/opentrad#36）。
//
// 目的：catch hands-off 路径回归（pnpm install → pnpm dev 起 Electron）。
// 主 ci.yml 的 lint/typecheck/test 永远跑系统 Node ABI 的 vitest，永远绿；
// 这个 job 模拟用户真起 Electron 的代码路径，确保 better-sqlite3 在 Electron
// ABI 下能真 dlopen + 跑 query。
//
// 用 ELECTRON_RUN_AS_NODE=1 让 electron 二进制以 Node 模式运行（不需要 GUI
// display，三平台 CI runner 都能跑，不依赖 xvfb）。
//
// 实现细节：
// - Windows 上 spawn .cmd 需要 shell:true，但 shell:true + -e 多行字符串会被
//   shell 切碎（实测：electron 报 "-e requires an argument"）。改写到临时
//   .cjs 文件再 electron <file> 跑，绕过 shell 拼接问题。

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DESKTOP_DIR = path.resolve(__dirname, "..");
const ELECTRON_BIN =
  process.platform === "win32"
    ? path.join(DESKTOP_DIR, "node_modules", ".bin", "electron.cmd")
    : path.join(DESKTOP_DIR, "node_modules", ".bin", "electron");

const TEST_CODE = `
const sqlite = require("better-sqlite3");
const db = new sqlite(":memory:");
db.exec("CREATE TABLE t(x INTEGER)");
db.exec("INSERT INTO t VALUES (42)");
const row = db.prepare("SELECT x FROM t").get();
if (row.x !== 42) {
  console.error("smoke fail: unexpected row", row);
  process.exit(2);
}
console.log("smoke OK: better-sqlite3 dlopen + query succeeded in Electron ABI=" + process.versions.modules + " electron=" + process.versions.electron);

const pty = require("node-pty");
if (typeof pty.spawn !== "function") {
  console.error("smoke fail: node-pty missing spawn");
  process.exit(3);
}
console.log("smoke OK: node-pty loaded (N-API, ABI-agnostic)");
`;

const tempScript = path.join(os.tmpdir(), `opentrad-smoke-${process.pid}.cjs`);
fs.writeFileSync(tempScript, TEST_CODE, "utf-8");

console.log(`[smoke] electron binary: ${ELECTRON_BIN}`);
console.log(`[smoke] temp script: ${tempScript}`);
console.log("[smoke] running Electron with ELECTRON_RUN_AS_NODE=1 ...");

try {
  const result = spawnSync(ELECTRON_BIN, [tempScript], {
    cwd: DESKTOP_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    // Windows 上 spawn .cmd 需要 shell:true。tempScript 路径只含合法字符（pid 数字），
    // 无 escape 风险。
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(
      `[smoke] FAIL: exit code ${result.status}, signal=${result.signal}, error=${result.error?.message ?? "none"}`,
    );
    process.exit(result.status ?? 1);
  }
  console.log("[smoke] PASS");
} finally {
  try {
    fs.unlinkSync(tempScript);
  } catch {
    // 静默
  }
}
