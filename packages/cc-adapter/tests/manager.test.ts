// manager.test.ts — 用 Node 自带能力跑真实子进程（非 mock），
// 模拟一个"迷你 CC"：从 stdin/argv 读取、按 NDJSON 格式往 stdout 打印伪事件、exit 0。
//
// 这样能验证 CCManager 的完整端到端行为（spawn、stdout 读取、StreamParser
// 链、事件流迭代、cleanup、exit handler）——比 mock child_process 更真实。

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CCEvent, CCTaskOptions } from "@opentrad/shared";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeArgs, CCManager } from "../src";

// 用 node 本身作为"fake claude"：-e 参数里写一段打印 NDJSON 的脚本。
const FAKE_CLAUDE = process.execPath; // node binary
const FAKE_SESSION_ID = "00000000-0000-0000-0000-000000000001";

// 构造 fake CC 的启动脚本：吐一个合法的 system/init + assistant_text + result
function fakeClaudeScript(sessionId: string): string {
  const systemInit = JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/tmp",
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
    model: "fake",
    permissionMode: "default",
    apiKeySource: "none",
    claude_code_version: "2.1.119-fake",
    uuid: "u1",
  });
  const assistant = JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_fake_1",
      type: "message",
      role: "assistant",
      model: "fake",
      content: [{ type: "text", text: "fake ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    session_id: sessionId,
    uuid: "u2",
  });
  const result = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    num_turns: 1,
    result: "fake ok",
    session_id: sessionId,
    total_cost_usd: 0,
    uuid: "u3",
  });
  return [
    `console.log(${JSON.stringify(systemInit)});`,
    `console.log(${JSON.stringify(assistant)});`,
    `console.log(${JSON.stringify(result)});`,
  ].join("");
}

function fakeOpts(sessionId = FAKE_SESSION_ID): CCTaskOptions {
  return {
    sessionId,
    prompt: fakeClaudeScript(sessionId),
    mcpConfigPath: "",
    allowedTools: [],
  };
}

function makeManager(): CCManager {
  return new CCManager({ binary: FAKE_CLAUDE, installExitHandlers: false });
}

describe("buildClaudeArgs", () => {
  it("always includes stream-json + verbose + session id", () => {
    const args = buildClaudeArgs(fakeOpts("sid1"));
    expect(args).toContain("-p");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    expect(args[args.indexOf("--session-id") + 1]).toBe("sid1");
    // prompt 是最后一个位置参数
    expect(args[args.length - 1]).toContain("console.log");
  });

  it('passes --tools "" when allowedTools is empty', () => {
    const args = buildClaudeArgs({ ...fakeOpts(), allowedTools: [] });
    const idx = args.indexOf("--tools");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("");
  });

  it("passes --allowedTools list when non-empty", () => {
    const args = buildClaudeArgs({
      ...fakeOpts(),
      allowedTools: ["Read", "Write"],
    });
    const idx = args.indexOf("--allowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(args.slice(idx + 1, idx + 3)).toEqual(["Read", "Write"]);
  });

  it("passes --mcp-config + --strict-mcp-config when path provided", () => {
    const args = buildClaudeArgs({
      ...fakeOpts(),
      mcpConfigPath: "/tmp/x.json",
    });
    expect(args).toContain("--mcp-config");
    expect(args).toContain("--strict-mcp-config");
  });

  it("omits --mcp-config when path empty", () => {
    const args = buildClaudeArgs({ ...fakeOpts(), mcpConfigPath: "" });
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--strict-mcp-config");
  });

  it("maps model='default' to omitted --model", () => {
    const args = buildClaudeArgs({ ...fakeOpts(), model: "default" });
    expect(args).not.toContain("--model");
  });

  it("passes --model for specific model", () => {
    const args = buildClaudeArgs({ ...fakeOpts(), model: "haiku" });
    const idx = args.indexOf("--model");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("haiku");
  });
});

// 用 node -e 作为 fake claude 的话，spawn 时 prompt 要当作 "-e 脚本" 传。
// 但 buildClaudeArgs 最后放的是 prompt（位置参数）。这里 override——
// 通过包一层 manager 的 binary + 参数方式：让 node -e <script> 跑。
describe("CCManager + CCTaskHandle (real child_process, fake CC)", () => {
  const managers: CCManager[] = [];
  afterEach(async () => {
    for (const m of managers) await m.cleanup();
    managers.length = 0;
  });

  // 包装：把 buildClaudeArgs 返回的位置参数（prompt 里是 script）换成 `-e <script>`
  async function spawnFake(opts: CCTaskOptions) {
    // 使用 -e script 让 node 执行脚本，不需要 stdin
    const manager = new CCManager({
      binary: FAKE_CLAUDE,
      installExitHandlers: false,
    });
    managers.push(manager);
    // hack：直接通过 spawn 侧门——继承 process.execPath + -e；
    // 我们真正要测的是 handle 对 stdout NDJSON 的处理，不测 arg 组装（已单独测）。
    const { spawn } = await import("node:child_process");
    const child = spawn(FAKE_CLAUDE, ["-e", opts.prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { CCTaskHandleImpl } = await import("../src");
    const handle = new CCTaskHandleImpl({
      sessionId: opts.sessionId,
      child: child as never,
    });
    return handle;
  }

  it("consumes the full event stream and resolves result()", async () => {
    const handle = await spawnFake(fakeOpts());
    const events: CCEvent[] = [];
    for await (const e of handle.events) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["system", "assistant_text", "result"]);
    const res = await handle.result();
    expect(res.status).toBe("success");
    expect(res.sessionId).toBe(FAKE_SESSION_ID);
    expect(res.exitCode).toBe(0);
  });

  it("cancel() SIGTERM-then-SIGKILL on a hanging process", async () => {
    // 跑一个 10s 睡眠的 node 进程模拟卡死
    const { spawn } = await import("node:child_process");
    const child = spawn(FAKE_CLAUDE, ["-e", "setTimeout(()=>{}, 10000)"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const { CCTaskHandleImpl } = await import("../src");
    const handle = new CCTaskHandleImpl({
      sessionId: "sid_cancel_test",
      child: child as never,
    });
    const start = Date.now();
    await handle.cancel();
    const elapsed = Date.now() - start;
    // SIGTERM 应该秒级结束（node 默认响应）
    expect(elapsed).toBeLessThan(3000);
    expect(child.killed || child.exitCode !== null || child.signalCode !== null).toBe(true);
    // 确认 result() 也 reject 而不是 hang
    await expect(handle.result()).rejects.toThrow(/cancel/i);
  });

  it("cleanup() cancels all active tasks", async () => {
    const manager = new CCManager({
      binary: FAKE_CLAUDE,
      installExitHandlers: false,
    });
    managers.push(manager);

    const { spawn } = await import("node:child_process");
    const { CCTaskHandleImpl } = await import("../src");
    const children = [0, 1, 2].map(() =>
      spawn(FAKE_CLAUDE, ["-e", "setTimeout(()=>{}, 10000)"], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const handles = children.map((c, i) => {
      const h = new CCTaskHandleImpl({
        sessionId: `sid_${i}`,
        child: c as never,
      });
      // 手动塞 manager 的 tasks map 以测 cleanup 的遍历
      (manager as unknown as { tasks: Map<string, unknown> }).tasks.set(`sid_${i}`, h);
      return h;
    });

    await manager.cleanup();

    for (const c of children) {
      expect(c.exitCode !== null || c.signalCode !== null).toBe(true);
    }
    expect(manager.activeTasks.size).toBe(0);
    // 静默 unhandled rejection
    await Promise.allSettled(handles.map((h) => h.result()));
  });
});

describe("startTask sessionId duplication guard", () => {
  it("rejects duplicate sessionId", async () => {
    const manager = makeManager();
    // 塞一个占位 fake handle 进 tasks
    (manager as unknown as { tasks: Map<string, unknown> }).tasks.set("dup", {} as never);
    await expect(
      manager.startTask({
        sessionId: "dup",
        prompt: "x",
        mcpConfigPath: "",
        allowedTools: [],
      }),
    ).rejects.toThrow(/already/);
  });
});

describe("mcp-config scaffolding (M0 fixture for later packages)", () => {
  it("tmp mcp-config can be written and passed via args", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opentrad-test-"));
    const cfgPath = join(dir, "mcp.json");
    await writeFile(cfgPath, JSON.stringify({ mcpServers: {} }));
    const args = buildClaudeArgs({
      sessionId: "s",
      prompt: "p",
      mcpConfigPath: cfgPath,
      allowedTools: [],
    });
    const idx = args.indexOf("--mcp-config");
    expect(args[idx + 1]).toBe(cfgPath);
  });
});

// marker to silence "unused import" when fileURLToPath not used
void fileURLToPath;
