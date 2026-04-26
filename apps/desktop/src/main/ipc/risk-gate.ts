// risk-gate:* IPC handlers(M1 #28 阶段 2)。
//
// renderer ↔ main 内部 channel(不走 mcp-server ↔ desktop 的 IPC bridge wire,
// 与 #25 hello 帧协议解耦):
// - risk-gate:confirm:main → renderer push(payload 含 requestId + 弹窗内容);本文件不
//   handle invoke,只是 channel 名字
// - risk-gate:response:renderer → main invoke,renderer 把用户决策(allow_once /
//   allow_always / deny / request_edit)+ requestId 回传;main 根据 requestId 解析
//   pending Promise(IpcRiskGatePrompter 内部维护)
//
// graceful degrade(D-M1-5):
// - 错误 / parse 失败:不 throw 让 renderer 收到 IPC error,renderer 应继续等(或
//   timeout 后由 main 进程超时 deny)。这避免 renderer 错误丢失 → mcp-server hang。

import {
  IpcChannels,
  type RiskGateResponsePayload,
  RiskGateResponsePayloadSchema,
} from "@opentrad/shared";
import { ipcMain } from "electron";
import type { IpcRiskGatePrompter } from "../services/risk-gate";

export interface RiskGateHandlerDeps {
  prompter: IpcRiskGatePrompter;
}

export function registerRiskGateHandlers(deps: RiskGateHandlerDeps): void {
  const { prompter } = deps;

  ipcMain.handle(IpcChannels.RiskGateResponse, async (_event, raw: unknown): Promise<void> => {
    const payload: RiskGateResponsePayload = RiskGateResponsePayloadSchema.parse(raw);
    prompter.resolveDecision(payload.requestId, payload.kind, payload.reason);
  });
}
