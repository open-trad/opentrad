// IPC bridge server（M1 #25）。Desktop 主进程暴露的 JSON-RPC 2.0 server，
// apps/mcp-server 通过 Unix socket / named pipe 连过来调 4 个方法。
//
// 设计：
// - 跨平台路径：macOS/Linux 用 ~/.opentrad/ipc.sock；Windows 用 \\.\pipe\opentrad-ipc
// - 多连接（B 拍板 Multi-session 留口）：每个 client 单独 ClientContext，
//   按 hello 帧的 sessionId 路由
// - 行分隔 NDJSON：跟 @opentrad/stream-parser 同模式，buffer + split('\n')
// - handshake 必需：第一帧不是 hello → 立刻断开（HandshakeRequired error）
// - 退出时 unlink socket 文件（Unix），避免残留

import { existsSync, unlinkSync } from "node:fs";
import * as net from "node:net";
import {
  type AuditLogRpcParams,
  AuditLogRpcParamsSchema,
  type DraftSaveRpcParams,
  DraftSaveRpcParamsSchema,
  type DraftSaveRpcResult,
  IPC_BRIDGE_PROTOCOL_VERSION,
  IpcBridgeHelloParamsSchema,
  IpcBridgeMethods,
  JsonRpcErrorCode,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type RiskGateRpcParams,
  RiskGateRpcParamsSchema,
  type RiskGateRpcResult,
  type SessionMetadataRpcParams,
  SessionMetadataRpcParamsSchema,
  type SessionMetadataRpcResult,
} from "@opentrad/shared";

export interface IpcBridgeHandlers {
  riskGateRequest(
    params: RiskGateRpcParams,
    ctx: { sessionId: string },
  ): Promise<RiskGateRpcResult>;
  auditLog(params: AuditLogRpcParams, ctx: { sessionId: string }): Promise<void>;
  draftSave(params: DraftSaveRpcParams, ctx: { sessionId: string }): Promise<DraftSaveRpcResult>;
  sessionMetadata(
    params: SessionMetadataRpcParams,
    ctx: { sessionId: string },
  ): Promise<SessionMetadataRpcResult>;
}

export interface IpcBridgeServerOptions {
  socketPath: string;
  handlers: IpcBridgeHandlers;
  // 第一帧不是 hello 的最长容忍时间（避免空连接占资源）。M1 默认 5s。
  helloTimeoutMs?: number;
}

interface ClientContext {
  socket: net.Socket;
  sessionId?: string; // hello 之前未知
  buffer: string;
  helloTimer?: NodeJS.Timeout;
}

export class IpcBridgeServer {
  private readonly server: net.Server;
  private readonly clients = new Set<ClientContext>();
  private listening = false;

  constructor(private readonly opts: IpcBridgeServerOptions) {
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  async start(): Promise<void> {
    if (this.listening) return;
    // Unix socket 残留清理（崩溃后重启）。Windows named pipe 不需要。
    if (process.platform !== "win32" && existsSync(this.opts.socketPath)) {
      try {
        unlinkSync(this.opts.socketPath);
      } catch {
        // 文件被占用 / 权限问题 → listen 时会暴露 EADDRINUSE
      }
    }

    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.socketPath, () => {
        this.server.removeListener("error", reject);
        this.listening = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.listening) return;
    for (const client of this.clients) {
      client.socket.destroy();
      if (client.helloTimer) clearTimeout(client.helloTimer);
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.listening = false;
    if (process.platform !== "win32" && existsSync(this.opts.socketPath)) {
      try {
        unlinkSync(this.opts.socketPath);
      } catch {
        // 静默
      }
    }
  }

  private onConnection(socket: net.Socket): void {
    const ctx: ClientContext = { socket, buffer: "" };
    this.clients.add(ctx);

    // hello 必须在 helloTimeoutMs 内到达，否则断开
    const timeoutMs = this.opts.helloTimeoutMs ?? 5000;
    ctx.helloTimer = setTimeout(() => {
      if (!ctx.sessionId) socket.destroy();
    }, timeoutMs);

    socket.setEncoding("utf-8");
    socket.on("data", (chunk: string) => this.onData(ctx, chunk));
    socket.on("close", () => {
      if (ctx.helloTimer) clearTimeout(ctx.helloTimer);
      this.clients.delete(ctx);
    });
    socket.on("error", () => {
      // 连接被对端断开 / 写错误 → 静默清理；不抛
    });
  }

  private onData(ctx: ClientContext, chunk: string): void {
    ctx.buffer += chunk;
    let nl = ctx.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = ctx.buffer.slice(0, nl).trim();
      ctx.buffer = ctx.buffer.slice(nl + 1);
      if (line) void this.handleLine(ctx, line);
      nl = ctx.buffer.indexOf("\n");
    }
  }

  private async handleLine(ctx: ClientContext, line: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // 协议层 parse 错误 → 不能用 id 回错（不知道 id），直接断开
      ctx.socket.destroy();
      return;
    }

    // 第一帧必须是 hello（notification 形态：method = $/hello,无 id）
    if (!ctx.sessionId) {
      const isHelloShape =
        typeof raw === "object" &&
        raw !== null &&
        (raw as { method?: unknown }).method === IpcBridgeMethods.Hello;
      if (!isHelloShape) {
        // 协议错：抢跑了 RPC。回 HandshakeRequired error 后断开
        const id = (raw as { id?: number | string } | null)?.id;
        if (id !== undefined) {
          this.send(ctx, {
            jsonrpc: "2.0",
            id,
            error: {
              code: JsonRpcErrorCode.HandshakeRequired,
              message: "must send $/hello before any request",
            },
          });
        }
        ctx.socket.destroy();
        return;
      }
      this.handleHello(ctx, raw as JsonRpcNotification);
      return;
    }

    // hello 之后 → 应该是 RPC request（带 id）。M1 不发 notification 给 server。
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as { method?: unknown }).method !== "string" ||
      (raw as { id?: unknown }).id === undefined
    ) {
      ctx.socket.destroy();
      return;
    }
    await this.handleRpc(ctx, raw as JsonRpcRequest);
  }

  private handleHello(ctx: ClientContext, msg: JsonRpcNotification): void {
    const parsed = IpcBridgeHelloParamsSchema.safeParse(msg.params);
    if (!parsed.success) {
      ctx.socket.destroy();
      return;
    }
    if (parsed.data.protocolVersion !== IPC_BRIDGE_PROTOCOL_VERSION) {
      // M1 严格匹配，M3 升级时改成兼容协商
      ctx.socket.destroy();
      return;
    }
    ctx.sessionId = parsed.data.sessionId;
    if (ctx.helloTimer) {
      clearTimeout(ctx.helloTimer);
      ctx.helloTimer = undefined;
    }
  }

  private async handleRpc(ctx: ClientContext, req: JsonRpcRequest): Promise<void> {
    const sessionId = ctx.sessionId;
    if (!sessionId) {
      // 不应该到这里（handleLine 已经守过 sessionId）
      return;
    }
    try {
      const result = await this.dispatch(req.method, req.params, sessionId);
      this.send(ctx, { jsonrpc: "2.0", id: req.id, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof MethodNotFoundError
          ? JsonRpcErrorCode.MethodNotFound
          : err instanceof InvalidParamsError
            ? JsonRpcErrorCode.InvalidParams
            : JsonRpcErrorCode.InternalError;
      this.send(ctx, { jsonrpc: "2.0", id: req.id, error: { code, message } });
    }
  }

  private async dispatch(method: string, params: unknown, sessionId: string): Promise<unknown> {
    const ctx = { sessionId };
    switch (method) {
      case IpcBridgeMethods.RiskGateRequest: {
        const p = parseOrThrow(RiskGateRpcParamsSchema, params);
        return this.opts.handlers.riskGateRequest(p, ctx);
      }
      case IpcBridgeMethods.AuditLog: {
        const p = parseOrThrow(AuditLogRpcParamsSchema, params);
        await this.opts.handlers.auditLog(p, ctx);
        return null;
      }
      case IpcBridgeMethods.DraftSave: {
        const p = parseOrThrow(DraftSaveRpcParamsSchema, params);
        return this.opts.handlers.draftSave(p, ctx);
      }
      case IpcBridgeMethods.SessionMetadata: {
        const p = parseOrThrow(SessionMetadataRpcParamsSchema, params);
        return this.opts.handlers.sessionMetadata(p, ctx);
      }
      default:
        throw new MethodNotFoundError(method);
    }
  }

  private send(ctx: ClientContext, msg: JsonRpcResponse): void {
    if (ctx.socket.destroyed) return;
    try {
      ctx.socket.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // 写失败（连接断了）→ 静默
    }
  }

  // 测试 / 健康检查用
  get clientCount(): number {
    return this.clients.size;
  }
}

class MethodNotFoundError extends Error {
  constructor(method: string) {
    super(`method not found: ${method}`);
    this.name = "MethodNotFoundError";
  }
}

class InvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidParamsError";
  }
}

function parseOrThrow<T>(
  schema: {
    safeParse(
      v: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: unknown } };
  },
  params: unknown,
): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new InvalidParamsError(`invalid params: ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
}
