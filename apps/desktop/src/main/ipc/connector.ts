// connector:* IPC handlers（M0.5：bb-browser 选品连接器 + 预检）。
// 所有 handler 返回结构化结果，不裸抛异常给 renderer。

import {
  type ConnectorActionResult,
  ConnectorOpenLoginRequestSchema,
  ConnectorSetEnabledRequestSchema,
  type ConnectorStatusResponse,
  IpcChannels,
} from "@opentrad/shared";
import { ipcMain } from "electron";
import type { ConnectorService } from "../services/connector-service";

export interface ConnectorHandlerDeps {
  connector: ConnectorService;
}

export function registerConnectorHandlers(deps: ConnectorHandlerDeps): void {
  const { connector } = deps;

  ipcMain.handle(IpcChannels.ConnectorStatus, async (): Promise<ConnectorStatusResponse> => {
    return connector.status();
  });

  ipcMain.handle(
    IpcChannels.ConnectorSetEnabled,
    async (_event, raw: unknown): Promise<string[]> => {
      const req = ConnectorSetEnabledRequestSchema.parse(raw);
      return connector.setEnabled(req.siteId, req.enabled);
    },
  );

  ipcMain.handle(IpcChannels.ConnectorDaemonStart, async (): Promise<ConnectorActionResult> => {
    return connector.startDaemon();
  });

  ipcMain.handle(
    IpcChannels.ConnectorOpenLogin,
    async (_event, raw: unknown): Promise<ConnectorActionResult> => {
      const req = ConnectorOpenLoginRequestSchema.parse(raw);
      return connector.openLogin(req.siteId);
    },
  );
}
