// BbBrowserRunner：包装 bb-browser CLI 的执行层。
//
// 为什么是 CLI 而非 MCP（ADR-001 补记，2026-07-09 实机验证）：
// bb-browser v0.14 无 mcp 子命令，此前 desktop 用 "bb-browser mcp" 导致
// MCPClientError: Connection closed。正确路径是 spawn `bb-browser site <cmd> --json`。
//
// 错误分层（都要接）：
// - 适配器层：--json 输出里 {error, hint, action} 三层结构（bb-sites DESIGN.md 规范）
// - CLI 层：非零退出码 + stderr（daemon/浏览器未就绪等）
// - 进程层：spawn ENOENT（CLI 未安装）、超时

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BbSite } from "./sites";

// 结构化结果：成功 data，或三层错误。desktop/tool-host 据此给友好提示而非裸报错。
export interface BbRunResult {
  ok: boolean;
  data?: unknown;
  // 失败时：三层错误信息（尽量填全）
  error?: string;
  hint?: string;
  action?: string;
}

// CLI 绝对路径解析：PATH 优先，兜底 ~/.npm-global/bin（发起人机器实际位置）。
// 返回可执行文件名或绝对路径（spawn 走 shell:false，PATH 由 env 提供）。
export function resolveBbBrowserPath(): string {
  const fallback = join(homedir(), ".npm-global", "bin", "bb-browser");
  if (existsSync(fallback)) return fallback;
  // 交给 PATH 解析
  return "bb-browser";
}

export interface RunnerOptions {
  // 覆盖 CLI 路径（测试注入）
  cliPath?: string;
  // 覆盖 spawn 实现（测试注入）
  spawnFn?: typeof spawn;
}

// 执行一次 bb-browser 命令，返回结构化结果。永不抛异常（全部转 BbRunResult）。
export async function runBbBrowser(
  args: string[],
  timeoutMs: number,
  opts: RunnerOptions = {},
): Promise<BbRunResult> {
  const cli = opts.cliPath ?? resolveBbBrowserPath();
  const spawnImpl = opts.spawnFn ?? spawn;
  return new Promise<BbRunResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnImpl(cli, [...args, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve(spawnErrorResult(err));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: BbRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({
        ok: false,
        error: `bb-browser 命令超时（>${Math.round(timeoutMs / 1000)}s）`,
        hint: "目标站点反爬较强或网络慢，可稍后重试，或先在浏览器打开该站过验证",
      });
    }, timeoutMs);

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => done(spawnErrorResult(err)));
    child.on("close", (code) => {
      // 优先解析 stdout JSON（成功或适配器三层错误都在这里）
      const parsed = tryParseJson(stdout);
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        // error 有两种形态（实机核实 2026-07-09）：
        // - 适配器层：字符串 + 可选 hint/action（bb-sites 规范）
        // - CLI/daemon 层：对象 {"error":{"message":"Daemon HTTP 400: ...No page target found..."}}
        //   ——早期版本把后者误判为成功透传，这就是"调用了插件但提示失败"的根因之一
        const errText = extractErrorText(obj.error);
        if (errText !== null) {
          done({
            ok: false,
            error: errText,
            hint: typeof obj.hint === "string" ? obj.hint : hintForCliError(errText),
            action: typeof obj.action === "string" ? obj.action : undefined,
          });
          return;
        }
        // 成功：bb-browser 用 {result: ...} 包裹
        done({ ok: true, data: "result" in obj ? obj.result : obj });
        return;
      }
      // 无 JSON：CLI 层失败（daemon/浏览器未就绪等）
      done(cliErrorResult(code, stderr || stdout));
    });
  });
}

// error 字段解包：字符串直接用；对象取 .message；其余非空值 stringify。null=无错误
function extractErrorText(error: unknown): string | null {
  if (error === undefined || error === null) return null;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
    return JSON.stringify(error);
  }
  return String(error);
}

// 已知 CLI/daemon 错误的友好提示
function hintForCliError(errText: string): string | undefined {
  if (errText.includes("No page target")) {
    return "受管浏览器没有打开的标签页，将自动打开后重试";
  }
  return undefined;
}

function spawnErrorResult(err: unknown): BbRunResult {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("ENOENT")) {
    return {
      ok: false,
      error: "未找到 bb-browser 命令",
      hint: "请先安装：npm install -g bb-browser",
      action: "npm install -g bb-browser",
    };
  }
  return { ok: false, error: `启动 bb-browser 失败：${msg}` };
}

function cliErrorResult(code: number | null, raw: string): BbRunResult {
  const text = raw.trim();
  // 识别常见的浏览器/daemon 未就绪
  if (/Chromium-based browser|Cannot find a/.test(text)) {
    return {
      ok: false,
      error: "浏览器未就绪",
      hint: "需要一个 Chromium 系浏览器（Chrome/Edge/Brave）并启动 bb-browser daemon。可在插件页点「启动浏览器服务」",
      action: "daemon:start",
    };
  }
  return {
    ok: false,
    error: text || `bb-browser 退出码 ${code}`,
    hint: "可在插件页查看浏览器服务状态并重试",
  };
}

function tryParseJson(s: string): unknown {
  const t = s.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // 有些命令可能多行输出，尝试取最后一个 JSON 对象行
    const lines = t.split("\n").reverse();
    for (const line of lines) {
      const l = line.trim();
      if (l.startsWith("{")) {
        try {
          return JSON.parse(l);
        } catch {}
      }
    }
    return null;
  }
}

// 把站点 + 输入参数拼成 bb-browser site 命令参数数组。
// 输入按站点 args schema 映射为 --key value；缺必填参数返回错误结果（不 spawn）。
export function buildSiteArgs(
  site: BbSite,
  input: Record<string, unknown>,
): string[] | BbRunResult {
  const args = ["site", site.command];
  for (const arg of site.args) {
    const v = input[arg.key];
    if (v === undefined || v === null || v === "") {
      if (arg.required) {
        return { ok: false, error: `缺少必填参数：${arg.key}（${arg.description}）` };
      }
      continue;
    }
    args.push(`--${arg.key}`, String(v));
  }
  return args;
}
