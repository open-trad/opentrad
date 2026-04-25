// IpcBridgeServer 协议层测试。
// 用 net.createConnection 直连 server，手写 hello / RPC 帧，验证协议处理逻辑。
// 不依赖真实 mcp-server；mcp-server 端的 IpcBridgeClient 单测在 mcp-server 包里。

import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPC_BRIDGE_PROTOCOL_VERSION, IpcBridgeMethods, JsonRpcErrorCode } from "@opentrad/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type IpcBridgeHandlers, IpcBridgeServer } from "../src/main/services/ipc-bridge-server";

interface ReceivedCalls {
  riskGate: number;
  audit: number;
  draft: number;
  metadata: number;
  lastSessionId?: string;
}

function fakeHandlers(): { handlers: IpcBridgeHandlers; calls: ReceivedCalls } {
  const calls: ReceivedCalls = { riskGate: 0, audit: 0, draft: 0, metadata: 0 };
  const handlers: IpcBridgeHandlers = {
    async riskGateRequest(_p, ctx) {
      calls.riskGate++;
      calls.lastSessionId = ctx.sessionId;
      return { decision: "allow", timestamp: Date.now() };
    },
    async auditLog(_p, ctx) {
      calls.audit++;
      calls.lastSessionId = ctx.sessionId;
    },
    async draftSave(_p, ctx) {
      calls.draft++;
      calls.lastSessionId = ctx.sessionId;
      return { path: "/fake/draft.md" };
    },
    async sessionMetadata(_p, ctx) {
      calls.metadata++;
      calls.lastSessionId = ctx.sessionId;
      return null;
    },
  };
  return { handlers, calls };
}

describe("IpcBridgeServer", () => {
  let tempDir: string;
  let socketPath: string;
  let server: IpcBridgeServer;
  let calls: ReceivedCalls;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "opentrad-bridge-"));
    socketPath = makeTestSocketPath(tempDir, "server");
    const { handlers, calls: c } = fakeHandlers();
    calls = c;
    server = new IpcBridgeServer({ socketPath, handlers, helloTimeoutMs: 1000 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("正常 hello + 4 个 RPC dispatch", async () => {
    const client = await connectClient(socketPath);
    sendHello(client, "test-session-1");

    // audit.log
    const auditResp = await rpc(client, IpcBridgeMethods.AuditLog, {
      sessionId: "test-session-1",
      toolName: "echo",
      decision: "allow",
      automated: true,
    });
    expect(auditResp.result).toBeNull();
    expect(calls.audit).toBe(1);
    expect(calls.lastSessionId).toBe("test-session-1");

    // risk-gate.request
    const rgResp = await rpc(client, IpcBridgeMethods.RiskGateRequest, {
      skillId: "trade-email-writer",
      toolName: "echo",
      params: {},
      riskLevel: "safe",
    });
    expect((rgResp.result as { decision: string }).decision).toBe("allow");
    expect(calls.riskGate).toBe(1);

    // draft.save
    const draftResp = await rpc(client, IpcBridgeMethods.DraftSave, {
      filename: "test.md",
      content: "hello",
    });
    expect((draftResp.result as { path: string }).path).toBe("/fake/draft.md");
    expect(calls.draft).toBe(1);

    // session.metadata
    const metaResp = await rpc(client, IpcBridgeMethods.SessionMetadata, {
      sessionId: "test-session-1",
    });
    expect(metaResp.result).toBeNull();
    expect(calls.metadata).toBe(1);

    client.destroy();
  });

  it("协议错：hello 之前发 RPC → server 回 HandshakeRequired error 并断开", async () => {
    const client = await connectClient(socketPath);
    // 抢跑 RPC（无 hello）
    const closed = waitForClose(client);
    const responsePromise = readOneResponse(client);
    client.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: IpcBridgeMethods.AuditLog,
        params: {},
      })}\n`,
    );
    const resp = await responsePromise;
    expect(resp.error?.code).toBe(JsonRpcErrorCode.HandshakeRequired);
    await closed; // 应被 server 断开
  });

  it("协议错：protocolVersion 不匹配 → server 直接断开", async () => {
    const client = await connectClient(socketPath);
    const closed = waitForClose(client);
    const helloFrame = {
      jsonrpc: "2.0",
      method: IpcBridgeMethods.Hello,
      params: {
        sessionId: "x",
        mcpServerPid: 1,
        protocolVersion: IPC_BRIDGE_PROTOCOL_VERSION + 99,
      },
    };
    client.write(`${JSON.stringify(helloFrame)}\n`);
    await closed;
  });

  it("hello timeout：超过 helloTimeoutMs 没发 hello → server 断开", async () => {
    const client = await connectClient(socketPath);
    const closed = waitForClose(client);
    // 不发任何数据；helloTimeoutMs = 1000 → 应在 ~1s 后被断开
    await closed;
  });

  it("clientCount：连上 / 断开同步反映", async () => {
    expect(server.clientCount).toBe(0);
    const c1 = await connectClient(socketPath);
    sendHello(c1, "s1");
    // 等一个 tick 让 server 注册
    await sleep(20);
    expect(server.clientCount).toBe(1);

    const c2 = await connectClient(socketPath);
    sendHello(c2, "s2");
    await sleep(20);
    expect(server.clientCount).toBe(2);

    c1.destroy();
    await sleep(50);
    expect(server.clientCount).toBe(1);
    c2.destroy();
    await sleep(50);
    expect(server.clientCount).toBe(0);
  });

  it("InvalidParams：audit.log 缺必要字段 → server 回 InvalidParams error", async () => {
    const client = await connectClient(socketPath);
    sendHello(client, "s1");
    const responsePromise = readOneResponse(client);
    client.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: IpcBridgeMethods.AuditLog,
        params: { sessionId: "s1" }, // 缺 toolName / decision / automated
      })}\n`,
    );
    const resp = await responsePromise;
    expect(resp.error?.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(calls.audit).toBe(0);
    client.destroy();
  });
});

// ---------- helpers ----------

// 跨平台测试 socket 路径：Unix 用 tempDir/ipc.sock；Windows 用 named pipe
// （\\.\pipe\<name>，不在文件系统）。production 路径在 db/paths.ts 同款分支。
function makeTestSocketPath(tempDir: string, label: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\opentrad-test-${label}-${process.pid}-${Date.now()}`;
  }
  return join(tempDir, "ipc.sock");
}

function connectClient(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.setEncoding("utf-8");
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

function sendHello(client: net.Socket, sessionId: string): void {
  const frame = {
    jsonrpc: "2.0",
    method: IpcBridgeMethods.Hello,
    params: {
      sessionId,
      mcpServerPid: process.pid,
      protocolVersion: IPC_BRIDGE_PROTOCOL_VERSION,
    },
  };
  client.write(`${JSON.stringify(frame)}\n`);
}

let nextRpcId = 1;
async function rpc(
  client: net.Socket,
  method: string,
  params: unknown,
): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
  const id = nextRpcId++;
  const responsePromise = readOneResponse(client, id);
  client.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return responsePromise;
}

function readOneResponse(
  client: net.Socket,
  matchId?: number,
): Promise<{
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: string): void => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      try {
        const parsed = JSON.parse(line);
        if (matchId !== undefined && parsed.id !== matchId) {
          // 可能是别的响应；M1 测试串行调用，应该不会乱序
          return;
        }
        client.removeListener("data", onData);
        resolve(parsed);
      } catch (err) {
        client.removeListener("data", onData);
        reject(err as Error);
      }
    };
    client.on("data", onData);
    setTimeout(() => {
      client.removeListener("data", onData);
      reject(new Error("readOneResponse timeout"));
    }, 5000);
  });
}

function waitForClose(client: net.Socket): Promise<void> {
  return new Promise((resolve) => client.once("close", () => resolve()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
