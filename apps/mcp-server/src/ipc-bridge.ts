// IPC bridge client（M1 #25）。mcp-server 端，连 desktop 主进程的 socket / named pipe。
//
// 协议：JSON-RPC 2.0 over NDJSON。第一帧发 $/hello notification，后续 RPC 请求/响应。
// Wire 协议详见 packages/shared/src/types/ipc-bridge.ts。
//
// graceful degrade（D-M1-5 已拍板，issue body 写明）：
// - 连接失败时，retry 3 次 exponential backoff（100 / 300 / 1000ms）
// - 全部失败后进入 offline 模式，不再尝试重连（M1 简化；M2 视需求加 long-term reconnect）
// - offline 时：
//   * risk-gate.request → 返回 deny（安全侧，避免无确认机制下任意调用）
//   * audit.log → buffer 在内存，重连成功后批量 flush（M1 不重连，所以等同丢弃 + warn）
//   * draft.save / session.metadata → throw IpcBridgeOfflineError（让 tool 调用上层报错）

import * as net from "node:net";
import {
  type AuditLogRpcParams,
  type DraftSaveRpcParams,
  type DraftSaveRpcResult,
  IPC_BRIDGE_PROTOCOL_VERSION,
  IpcBridgeMethods,
  type JsonRpcResponse,
  JsonRpcResponseSchema,
  type RiskGateRpcParams,
  type RiskGateRpcResult,
  type SessionMetadataRpcParams,
  type SessionMetadataRpcResult,
} from "@opentrad/shared";

export class IpcBridgeOfflineError extends Error {
  readonly code = "IPC_BRIDGE_OFFLINE" as const;
  constructor(method: string) {
    super(`IPC bridge is offline; cannot call ${method}`);
    this.name = "IpcBridgeOfflineError";
  }
}

export interface IpcBridgeClientOptions {
  socketPath: string;
  sessionId: string;
  mcpServerPid: number;
  rpcTimeoutMs?: number; // 单次 RPC 超时，默认 30s
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class IpcBridgeClient {
  private socket?: net.Socket;
  private connected = false;
  private offline = false; // 初次连接全失败后进入；M1 不重连
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly auditBuffer: AuditLogRpcParams[] = [];

  constructor(private readonly opts: IpcBridgeClientOptions) {}

  // 初次连接 + retry 3 次 exponential backoff。失败后 offline = true。
  async connect(): Promise<void> {
    const delays = [100, 300, 1000];
    for (let i = 0; i <= delays.length; i++) {
      try {
        await this.tryConnectOnce();
        this.sendHello();
        this.flushAuditBuffer();
        return;
      } catch (err) {
        if (i === delays.length) {
          this.offline = true;
          this.warn(
            `IPC bridge connect failed after ${delays.length + 1} attempts; falling back to offline mode (${(err as Error).message})`,
          );
          return;
        }
        await sleep(delays[i] as number);
      }
    }
  }

  private async tryConnectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.opts.socketPath);
      const onError = (err: Error): void => {
        socket.removeAllListeners();
        socket.destroy();
        reject(err);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.removeListener("error", onError);
        socket.setEncoding("utf-8");
        socket.on("data", (chunk: string) => this.onData(chunk));
        socket.on("close", () => this.onClose());
        socket.on("error", () => {
          // 连接稳定后的错误：rejectAll pending、走 offline
          this.onClose();
        });
        this.socket = socket;
        this.connected = true;
        resolve();
      });
    });
  }

  private sendHello(): void {
    if (!this.socket) return;
    const helloFrame = {
      jsonrpc: "2.0" as const,
      method: IpcBridgeMethods.Hello,
      params: {
        sessionId: this.opts.sessionId,
        mcpServerPid: this.opts.mcpServerPid,
        protocolVersion: IPC_BRIDGE_PROTOCOL_VERSION,
      },
    };
    this.socket.write(`${JSON.stringify(helloFrame)}\n`);
  }

  private flushAuditBuffer(): void {
    if (this.auditBuffer.length === 0) return;
    const drained = this.auditBuffer.splice(0, this.auditBuffer.length);
    for (const params of drained) {
      // 不 await：批量 flush 不阻塞 connect
      void this.request<void>(IpcBridgeMethods.AuditLog, params).catch((err) =>
        this.warn(`audit.log flush failed: ${(err as Error).message}`),
      );
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handleLine(line);
      nl = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.warn(`failed to parse server line: ${line.slice(0, 200)}`);
      return;
    }
    const parsed = JsonRpcResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.warn("ignoring malformed JSON-RPC response");
      return;
    }
    this.dispatchResponse(parsed.data);
  }

  private dispatchResponse(msg: JsonRpcResponse): void {
    if (typeof msg.id !== "number") return; // 不识别 string id（M1 不发 string id）
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private onClose(): void {
    this.connected = false;
    this.offline = true; // M1 不重连
    this.socket = undefined;
    // reject 所有 pending
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      p.reject(new Error("IPC bridge connection closed"));
      this.pending.delete(id);
    }
  }

  // 通用 request；调用方传入 method 字符串
  private request<T>(method: string, params: unknown): Promise<T> {
    if (this.offline || !this.connected || !this.socket) {
      throw new IpcBridgeOfflineError(method);
    }
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timeout = this.opts.rpcTimeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout (${timeout}ms): ${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      const frame = { jsonrpc: "2.0", id, method, params };
      this.socket?.write(`${JSON.stringify(frame)}\n`);
    });
  }

  // -------- 4 个 typed wrapper（含 graceful degrade） --------

  async riskGateRequest(params: RiskGateRpcParams): Promise<RiskGateRpcResult> {
    if (this.offline) {
      // 离线时 deny 是安全侧默认（D-M1-5）
      return {
        decision: "deny",
        reason: "ipc bridge offline (mcp-server graceful degrade)",
        timestamp: Date.now(),
      };
    }
    return this.request<RiskGateRpcResult>(IpcBridgeMethods.RiskGateRequest, params);
  }

  async auditLog(params: AuditLogRpcParams): Promise<void> {
    if (this.offline) {
      // 离线时 buffer（M1 不重连，等同 warn 后丢弃；M2 加重连后真 flush）
      this.auditBuffer.push(params);
      return;
    }
    await this.request<unknown>(IpcBridgeMethods.AuditLog, params);
  }

  async draftSave(params: DraftSaveRpcParams): Promise<DraftSaveRpcResult> {
    if (this.offline) throw new IpcBridgeOfflineError(IpcBridgeMethods.DraftSave);
    return this.request<DraftSaveRpcResult>(IpcBridgeMethods.DraftSave, params);
  }

  async sessionMetadata(params: SessionMetadataRpcParams): Promise<SessionMetadataRpcResult> {
    if (this.offline) throw new IpcBridgeOfflineError(IpcBridgeMethods.SessionMetadata);
    return this.request<SessionMetadataRpcResult>(IpcBridgeMethods.SessionMetadata, params);
  }

  // -------- 状态查询 + 关闭 --------

  get isConnected(): boolean {
    return this.connected;
  }

  get isOffline(): boolean {
    return this.offline;
  }

  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }
    this.connected = false;
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      p.reject(new Error("IPC bridge client closed by caller"));
      this.pending.delete(id);
    }
  }

  // mcp-server 走 stdio MCP 协议时，stdout 不能 console.log（会污染 wire 流）。
  // 用 stderr 输出 warn —— stderr 在 CC 拉起的 stdio MCP server 里是允许的诊断通道。
  private warn(msg: string): void {
    process.stderr.write(`[opentrad-mcp][ipc-bridge] ${msg}\n`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
