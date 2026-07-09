// IPC handler 统一注册入口。启动时在 app.whenReady 里调一次。
// 新增 domain 时在此 register 进来。

import type { CCManager } from "@opentrad/cc-adapter";
import type { AgentService } from "../services/agent-service";
import type { DetectLoopRegistry } from "../services/cc-detect-loop";
import type { SafeStorageCredentialStore } from "../services/credential-store";
import type { DbServices } from "../services/db";
import type { McpConfigWriter } from "../services/mcp-writer";
import type { PtyManager } from "../services/pty-manager";
import type { IpcRiskGatePrompter } from "../services/risk-gate";
import { registerAgentHandlers } from "./agent";
import { registerAuthHandlers } from "./auth";
import { registerCcHandlers } from "./cc";
import { registerInstalledSkillHandlers } from "./installed-skill";
import { registerInstallerHandlers } from "./installer";
import { registerPtyHandlers } from "./pty";
import { registerRiskGateHandlers } from "./risk-gate";
import { registerSessionHandlers } from "./session";
import { registerSettingsHandlers } from "./settings";
import { registerSkillHandlers } from "./skill";

export interface IpcDeps {
  manager: CCManager;
  db: DbServices;
  pty: PtyManager;
  mcpWriter: McpConfigWriter;
  detectLoop: DetectLoopRegistry;
  riskGatePrompter: IpcRiskGatePrompter;
  agent: AgentService;
  credentials: SafeStorageCredentialStore;
}

export function registerIpcHandlers(deps: IpcDeps): void {
  registerCcHandlers({ manager: deps.manager, db: deps.db, mcpWriter: deps.mcpWriter });
  registerAgentHandlers({ agent: deps.agent, credentials: deps.credentials });
  registerSessionHandlers(deps.db);
  registerSettingsHandlers(deps.db);
  registerInstalledSkillHandlers(deps.db);
  registerPtyHandlers(deps.pty);
  registerInstallerHandlers({ pty: deps.pty, detectLoop: deps.detectLoop });
  registerAuthHandlers({ pty: deps.pty });
  registerSkillHandlers();
  registerRiskGateHandlers({ prompter: deps.riskGatePrompter, db: deps.db });
}
