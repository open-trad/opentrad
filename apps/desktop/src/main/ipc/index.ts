// IPC handler 统一注册入口。启动时在 app.whenReady 里调一次。
// 新增 domain 时在此 register 进来。

import type { CCManager } from "@opentrad/cc-adapter";
import type { RuntimeAdapter } from "@opentrad/runtime-adapter";
import type { AgentService } from "../services/agent-service";
import type { DetectLoopRegistry } from "../services/cc-detect-loop";
import type { ConnectorService } from "../services/connector-service";
import type { DbServices } from "../services/db";
import type { HermesNetworkEnvironment } from "../services/hermes/network-environment";
import {
  createHermesOAuthPtyCoordinator,
  type HermesOAuthPtyCoordinator,
  type HermesOAuthPtyCoordinatorOptions,
} from "../services/hermes/oauth-login";
import type { McpConfigWriter } from "../services/mcp-writer";
import type { PtyManager } from "../services/pty-manager";
import type { IpcRiskGatePrompter } from "../services/risk-gate";
import { registerAgentHandlers } from "./agent";
import { registerAuthHandlers } from "./auth";
import { registerCcHandlers } from "./cc";
import { registerConnectorHandlers } from "./connector";
import { registerInstalledSkillHandlers } from "./installed-skill";
import { registerInstallerHandlers } from "./installer";
import { registerPtyHandlers } from "./pty";
import { registerRiskGateHandlers } from "./risk-gate";
import { registerSessionHandlers } from "./session";
import { registerSettingsHandlers } from "./settings";
import { registerSkillHandlers } from "./skill";
import { registerUpdateHandlers } from "./update";

export interface IpcDeps {
  manager: CCManager;
  db: DbServices;
  pty: PtyManager;
  mcpWriter: McpConfigWriter;
  detectLoop: DetectLoopRegistry;
  riskGatePrompter: IpcRiskGatePrompter;
  agent: AgentService;
  connector: ConnectorService;
  hermesRuntime: RuntimeAdapter | undefined;
  hermesDataRoot: string;
  hermesPlatform: HermesOAuthPtyCoordinatorOptions["platform"];
  hermesNetworkEnvironment: HermesNetworkEnvironment;
  onHermesOAuthCoordinator?: (coordinator: HermesOAuthPtyCoordinator) => void;
}

export function registerIpcHandlers(deps: IpcDeps): void {
  registerCcHandlers({ manager: deps.manager, db: deps.db, mcpWriter: deps.mcpWriter });
  registerAgentHandlers({ agent: deps.agent });
  registerConnectorHandlers({ connector: deps.connector });
  registerUpdateHandlers();
  registerSessionHandlers(deps.db);
  registerSettingsHandlers(deps.db);
  registerInstalledSkillHandlers(deps.db);
  const ptyRouter = registerPtyHandlers(deps.pty);
  registerInstallerHandlers({
    pty: deps.pty,
    ptyRouter,
    detectLoop: deps.detectLoop,
  });
  const hermesOAuth = createHermesOAuthPtyCoordinator({
    dataRoot: deps.hermesDataRoot,
    platform: deps.hermesPlatform,
    ...(deps.hermesRuntime ? { runtime: deps.hermesRuntime } : {}),
    listProfiles: () => deps.agent.listProfiles(),
    isProfileAvailable: (profileId) => deps.agent.isProfileAvailableForOAuth(profileId),
    pty: deps.pty,
    ptyRouter,
    networkEnvironment: deps.hermesNetworkEnvironment,
  });
  deps.onHermesOAuthCoordinator?.(hermesOAuth);
  registerAuthHandlers({
    pty: deps.pty,
    ptyRouter,
    hermesOAuth,
  });
  registerSkillHandlers();
  registerRiskGateHandlers({ prompter: deps.riskGatePrompter, db: deps.db });
}
