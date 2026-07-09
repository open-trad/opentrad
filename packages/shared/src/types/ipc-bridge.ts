// IPC bridge wire protocol（M1 #25 / open-trad/opentrad#25）。
// Desktop 主进程 ↔ apps/mcp-server 之间的 RPC 通道。
//
// 传输：Unix domain socket（macOS/Linux）/ named pipe（Windows）+ NDJSON
// 协议：JSON-RPC 2.0
//
// 握手：client connect 后立即发送 Hello notification（method = "$/hello"），
// 携带 sessionId / mcpServerPid / protocolVersion。Server 用 sessionId 路由。
// 决策来源：M1 §三 Multi-session 协议留口（B 拍板，详见 issue #25 body 开工前对齐）。
//
// 4 个 RPC 方法（M1 mock + 真实分阶段，见 issue body）：
// - $/hello                  notification（无回复）。client → server，第一帧。
// - risk-gate.request        request。M1 mock 返回 allow；真实在 M1 #11 / #28
// - audit.log                request（fire-and-forget 也可，但用 request 让 client 知道写成功）
// - draft.save               request
// - session.metadata         request

import { z } from "zod";
import { AuditLogAppendInputSchema } from "./db";
import { SessionMetaSchema } from "./ipc";
import { RiskGateDecisionSchema, RiskGateRequestSchema } from "./risk-gate";

// 协议版本：M1 = 1。M3 如有破坏性变更升 2 + 需 server 协商兼容版本。
export const IPC_BRIDGE_PROTOCOL_VERSION = 1;

// 跨平台 socket / named pipe 路径（统一接口）。
// macOS / Linux：Unix domain socket，~/.opentrad/ipc.sock
// Windows：named pipe，\\.\pipe\opentrad-ipc

export const IpcBridgeMethods = {
  Hello: "$/hello",
  RiskGateRequest: "risk-gate.request",
  AuditLog: "audit.log",
  DraftSave: "draft.save",
  SessionMetadata: "session.metadata",
} as const;

export type IpcBridgeMethod = (typeof IpcBridgeMethods)[keyof typeof IpcBridgeMethods];

// -------- $/hello（client → server，notification） --------

export const IpcBridgeHelloParamsSchema = z.object({
  sessionId: z.string(),
  mcpServerPid: z.number().int(),
  protocolVersion: z.number().int(),
});

export type IpcBridgeHelloParams = z.infer<typeof IpcBridgeHelloParamsSchema>;

// -------- risk-gate.request --------
// 复用 risk-gate.ts schema。M1 mock 总是返回 allow（在 server handler 做）。

export const RiskGateRpcParamsSchema = RiskGateRequestSchema;
export type RiskGateRpcParams = z.infer<typeof RiskGateRpcParamsSchema>;

export const RiskGateRpcResultSchema = RiskGateDecisionSchema;
export type RiskGateRpcResult = z.infer<typeof RiskGateRpcResultSchema>;

// -------- audit.log --------
// 复用 db.ts AuditLogAppendInput。返回 void。

export const AuditLogRpcParamsSchema = AuditLogAppendInputSchema;
export type AuditLogRpcParams = z.infer<typeof AuditLogRpcParamsSchema>;

// -------- draft.save --------
// 把 skill 生成的草稿写到 ~/.opentrad/drafts/{date}-{filename}.md。
// content 是 markdown 文本；filename 不含日期前缀（server 自动加）。

export const DraftSaveRpcParamsSchema = z.object({
  filename: z.string().min(1),
  content: z.string(),
});

export type DraftSaveRpcParams = z.infer<typeof DraftSaveRpcParamsSchema>;

export const DraftSaveRpcResultSchema = z.object({
  path: z.string(), // 写入的绝对路径
});

export type DraftSaveRpcResult = z.infer<typeof DraftSaveRpcResultSchema>;

// -------- session.metadata --------
// 输入 sessionId，返回 SessionMeta（精简视图，不暴露 ccSessionPath 等内部字段）。
// 不存在时返回 null。

export const SessionMetadataRpcParamsSchema = z.object({
  sessionId: z.string(),
});

export type SessionMetadataRpcParams = z.infer<typeof SessionMetadataRpcParamsSchema>;

export const SessionMetadataRpcResultSchema = SessionMetaSchema.nullable();
export type SessionMetadataRpcResult = z.infer<typeof SessionMetadataRpcResultSchema>;

// -------- JSON-RPC 2.0 envelope schemas --------
// 简化版：M1 仅识别 notification / request / response / error 四种基本形态。

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.unknown().optional(),
});

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
});

export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().int(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

// JSON-RPC 2.0 标准错误码。
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // OpenTrad 自定义错误（-32000 ~ -32099 是 server-defined application 错误段）
  HandshakeRequired: -32001, // 客户端在 hello 之前发了 RPC
  HandshakeProtocolMismatch: -32002, // protocolVersion 不兼容
} as const;
