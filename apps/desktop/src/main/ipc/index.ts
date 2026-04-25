// IPC handler 统一注册入口。启动时在 app.whenReady 里调一次。
// 新增 domain 时在此 register 进来。

import type { CCManager } from "@opentrad/cc-adapter";
import type { DbServices } from "../services/db";
import type { McpConfigWriter } from "../services/mcp-writer";
import type { PtyManager } from "../services/pty-manager";
import { registerCcHandlers } from "./cc";
import { registerInstalledSkillHandlers } from "./installed-skill";
import { registerPtyHandlers } from "./pty";
import { registerSessionHandlers } from "./session";
import { registerSettingsHandlers } from "./settings";

export interface IpcDeps {
  manager: CCManager;
  db: DbServices;
  pty: PtyManager;
  mcpWriter: McpConfigWriter;
}

export function registerIpcHandlers(deps: IpcDeps): void {
  registerCcHandlers({ manager: deps.manager, db: deps.db, mcpWriter: deps.mcpWriter });
  registerSessionHandlers(deps.db);
  registerSettingsHandlers(deps.db);
  registerInstalledSkillHandlers(deps.db);
  registerPtyHandlers(deps.pty);
  // 后续 domain：skill / risk-gate / installer 在此注册
}
