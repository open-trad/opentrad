// node-pty 1.1.0 的 prebuild 包没给 spawn-helper 设可执行位（只 Windows 上的 conpty.dll
// 在自己的 post-install 里处理）。Linux / macOS 上 pty.spawn 会因此 posix_spawnp failed。
// 在 root postinstall 里跨平台 chmod +x，让所有 contributor / CI runner 装完即用。
//
// Windows 上 spawn-helper 不存在（不需要），脚本静默跳过。

const { chmodSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const { readdirSync } = require("node:fs");

const NODE_PTY_PNPM_DIR = join(__dirname, "..", "node_modules", ".pnpm");

if (!existsSync(NODE_PTY_PNPM_DIR)) {
  process.exit(0);
}

let fixedCount = 0;

for (const entry of readdirSync(NODE_PTY_PNPM_DIR)) {
  if (!entry.startsWith("node-pty@")) continue;
  const prebuildsDir = join(NODE_PTY_PNPM_DIR, entry, "node_modules", "node-pty", "prebuilds");
  if (!existsSync(prebuildsDir)) continue;
  for (const platform of readdirSync(prebuildsDir)) {
    const helper = join(prebuildsDir, platform, "spawn-helper");
    if (existsSync(helper)) {
      try {
        chmodSync(helper, 0o755);
        fixedCount++;
      } catch {
        // 权限不够 / 文件被占用 → 静默
      }
    }
  }
}

if (fixedCount > 0) {
  console.log(`[fix-node-pty-perms] chmod +x on ${fixedCount} spawn-helper binaries`);
}
