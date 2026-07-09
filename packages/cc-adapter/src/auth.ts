// CC 登录状态检测：跑 `claude auth status --text`，parse 登录状态。
// 2026-04 实测 CC 2.1.119 --text 输出样例：
//   Login method: Claude Pro account
//   Organization: <org name>
//   Email: <email>
// 未登录时 CC 退出码 non-zero 或输出 "Not logged in" 等——把所有非 "Login method:" 归为未登录。
// 输出格式可能随 CC 版本漂移，本文件是单点 parse 层，破了只改这里。

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AuthStatus {
  loggedIn: boolean;
  method?: "subscription" | "api_key";
  email?: string;
  organization?: string;
  error?: string;
}

// 把 email 脱敏为 "u***@example.com" 形式，避免任何日志/IPC 泄漏明文。
export function redactEmail(email: string): string {
  const atIdx = email.indexOf("@");
  if (atIdx <= 0) return "***";
  const localFirst = email[0] ?? "*";
  const domain = email.slice(atIdx + 1);
  return `${localFirst}***@${domain}`;
}

function classifyMethod(methodLine: string): "subscription" | "api_key" | undefined {
  // 已知两种：
  //   "Claude Pro account" / "Claude Max account" → subscription
  //   "API key" / "Anthropic API key" → api_key
  const lower = methodLine.toLowerCase();
  if (lower.includes("pro account") || lower.includes("max account")) {
    return "subscription";
  }
  if (lower.includes("api key")) return "api_key";
  return undefined;
}

export async function getAuthStatus(binary = "claude"): Promise<AuthStatus> {
  try {
    const { stdout } = await execFileAsync(binary, ["auth", "status", "--text"], {
      timeout: 10000,
    });
    return parseAuthStatus(stdout);
  } catch (err) {
    // 非零退出码也可能是"未登录"。先尝试 parse stderr/stdout，再走默认。
    const child = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (typeof child.stdout === "string" && child.stdout.trim()) {
      return parseAuthStatus(child.stdout);
    }
    if (child.code === "ENOENT") {
      return { loggedIn: false, error: "claude binary not found in PATH" };
    }
    return {
      loggedIn: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 从 --text 输出提取字段。输出是 key: value 按行分布（无严格 schema）。
export function parseAuthStatus(raw: string): AuthStatus {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    fields[key] = value;
  }

  const methodLine = fields["login method"];
  if (!methodLine) {
    return { loggedIn: false };
  }

  return {
    loggedIn: true,
    method: classifyMethod(methodLine),
    email: fields.email,
    organization: fields.organization,
  };
}
