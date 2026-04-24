// CC 安装检测：跑 `claude --version`，parse 版本号。
// 2026-04 实测 CC 2.1.119 输出格式："2.1.119 (Claude Code)"

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DetectInstallationResult {
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
}

// 匹配 "X.Y.Z" 或 "X.Y.Z (label)" 开头的版本号
const VERSION_RE = /^(\d+\.\d+\.\d+(?:[.\-+][\w.]*)?)/;

export async function detectInstallation(binary = "claude"): Promise<DetectInstallationResult> {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], {
      timeout: 5000,
    });
    const trimmed = stdout.trim();
    const match = VERSION_RE.exec(trimmed);
    if (!match?.[1]) {
      return {
        installed: false,
        error: `unparsable version output: ${JSON.stringify(trimmed)}`,
      };
    }
    return { installed: true, version: match[1], path: binary };
  } catch (err) {
    // ENOENT → CC 没装；其他 → 也当 not installed，但把原始错误暴露出去
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { installed: false, error: "claude binary not found in PATH" };
    }
    return {
      installed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
