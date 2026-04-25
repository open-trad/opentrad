// IpcBridgeClient 测试。
// 重点 1：graceful degrade（offline 时 risk-gate 返 deny / audit.log 进 buffer / 其他 throw）
// 重点 2：正常路径用 fake net server 验证 hello frame + RPC 回复

import { mkdtempSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IPC_BRIDGE_PROTOCOL_VERSION, IpcBridgeMethods } from "@opentrad/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IpcBridgeClient, IpcBridgeOfflineError } from "../src/ipc-bridge";

describe("IpcBridgeClient — graceful degrade（连不上 socket）", () => {
  it("connect 失败后进入 offline 模式，risk-gate.request 返回 deny", async () => {
    const client = new IpcBridgeClient({
      socketPath: "/nonexistent/sock-path",
      sessionId: "s1",
      mcpServerPid: process.pid,
    });
    await client.connect();
    expect(client.isOffline).toBe(true);
    expect(client.isConnected).toBe(false);

    const decision = await client.riskGateRequest({
      skillId: "x",
      toolName: "echo",
      params: {},
      riskLevel: "safe",
    });
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toMatch(/offline/i);
  });

  it("offline 时 audit.log 不抛，进 buffer", async () => {
    const client = new IpcBridgeClient({
      socketPath: "/nonexistent/sock",
      sessionId: "s1",
      mcpServerPid: process.pid,
    });
    await client.connect();
    await expect(
      client.auditLog({
        sessionId: "s1",
        toolName: "echo",
        decision: "allow",
        automated: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("offline 时 draft.save 抛 IpcBridgeOfflineError", async () => {
    const client = new IpcBridgeClient({
      socketPath: "/nonexistent/sock",
      sessionId: "s1",
      mcpServerPid: process.pid,
    });
    await client.connect();
    await expect(client.draftSave({ filename: "x.md", content: "..." })).rejects.toBeInstanceOf(
      IpcBridgeOfflineError,
    );
  });

  it("offline 时 session.metadata 抛 IpcBridgeOfflineError", async () => {
    const client = new IpcBridgeClient({
      socketPath: "/nonexistent/sock",
      sessionId: "s1",
      mcpServerPid: process.pid,
    });
    await client.connect();
    await expect(client.sessionMetadata({ sessionId: "s1" })).rejects.toBeInstanceOf(
      IpcBridgeOfflineError,
    );
  });
});

describe("IpcBridgeClient — 正常路径（fake net server）", () => {
  let tempDir: string;
  let socketPath: string;
  let server: net.Server;
  let receivedHello: { sessionId?: string; protocolVersion?: number } = {};

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "opentrad-bridge-client-"));
    socketPath = makeTestSocketPath(tempDir);
    receivedHello = {};

    server = net.createServer((socket) => {
      socket.setEncoding("utf-8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) {
            nl = buffer.indexOf("\n");
            continue;
          }
          const msg = JSON.parse(line);
          if (msg.method === IpcBridgeMethods.Hello) {
            receivedHello = {
              sessionId: msg.params?.sessionId,
              protocolVersion: msg.params?.protocolVersion,
            };
            // hello 是 notification，不回复
          } else if (msg.method === IpcBridgeMethods.RiskGateRequest) {
            socket.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: { decision: "allow", timestamp: 12345 },
              })}\n`,
            );
          } else if (msg.method === IpcBridgeMethods.AuditLog) {
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null })}\n`);
          }
          nl = buffer.indexOf("\n");
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("connect 后立即发 hello frame（含 sessionId / protocolVersion）", async () => {
    const client = new IpcBridgeClient({
      socketPath,
      sessionId: "test-session-x",
      mcpServerPid: process.pid,
    });
    await client.connect();
    // 给 fake server 一拍读 hello
    await sleep(30);
    expect(client.isConnected).toBe(true);
    expect(client.isOffline).toBe(false);
    expect(receivedHello.sessionId).toBe("test-session-x");
    expect(receivedHello.protocolVersion).toBe(IPC_BRIDGE_PROTOCOL_VERSION);
    client.close();
  });

  it("riskGateRequest 路由到 server，返回 server 的 decision", async () => {
    const client = new IpcBridgeClient({
      socketPath,
      sessionId: "s",
      mcpServerPid: process.pid,
    });
    await client.connect();
    const decision = await client.riskGateRequest({
      skillId: "x",
      toolName: "echo",
      params: { msg: "hi" },
      riskLevel: "safe",
    });
    expect(decision.decision).toBe("allow");
    expect(decision.timestamp).toBe(12345);
    client.close();
  });

  it("auditLog 在线时正常 RPC（不进 buffer）", async () => {
    const client = new IpcBridgeClient({
      socketPath,
      sessionId: "s",
      mcpServerPid: process.pid,
    });
    await client.connect();
    await expect(
      client.auditLog({
        sessionId: "s",
        toolName: "echo",
        decision: "allow",
        automated: true,
      }),
    ).resolves.toBeUndefined();
    client.close();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 跨平台测试 socket 路径：Unix 用 tempDir/ipc.sock；Windows 用 named pipe
// （\\.\pipe\<name>，不在文件系统）。production 路径在 db/paths.ts 同款分支。
function makeTestSocketPath(tempDir: string): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\opentrad-test-client-${process.pid}-${Date.now()}`;
  }
  return join(tempDir, "ipc.sock");
}
