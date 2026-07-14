// agent:* IPC handlers（M0 spike：自建 agent loop 接线）。
//
// 通道语义：
// - agent:start-session：建会话（挂 MCP、绑 profile），返回 sessionId
// - agent:send：fire-and-forget——loop 一轮可能分钟级，事件经 agent:event 持续推回，
//   invoke 立即返回；状态错误转 agent_error 事件（agent-service 内处理）
// - agent:abort：中止会话
// - agent:event：main → renderer push（本文件不 handle，只是发送端）
// - agent:profiles:*：Settings Providers 页 CRUD；可选 secret 与 Profile 走同一 mutation，
//   只进 main（safeStorage 加密落库），永不回读、永不进 log。

import { type ProviderProfile, ProviderProfileSchema } from "@opentrad/model-providers";
import {
  AgentAbortRequestSchema,
  AgentProfileDeleteRequestSchema,
  AgentProfileSaveRequestSchema,
  AgentSendRequestSchema,
  AgentSessionLoadRequestSchema,
  type AgentSessionMeta,
  AgentSessionOpenRequestSchema,
  type AgentSessionOpenResponse,
  AgentStartSessionRequestSchema,
  type AgentStartSessionResponse,
  type AgentWorkspaceSelectResponse,
  IpcChannels,
} from "@opentrad/shared";
import { BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from "electron";
import type { AgentService } from "../services/agent-service";
import { validateWorkspaceRoot } from "../services/workspace-root";

export interface AgentHandlerDeps {
  agent: AgentService;
}

export function registerAgentHandlers(deps: AgentHandlerDeps): void {
  const { agent } = deps;

  ipcMain.handle(
    IpcChannels.AgentWorkspaceSelect,
    async (event): Promise<AgentWorkspaceSelectResponse> => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: OpenDialogOptions = {
        title: "选择 Hermes 工作区",
        buttonLabel: "使用此文件夹",
        properties: ["openDirectory", "createDirectory"],
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      const selected = result.filePaths[0];
      if (result.canceled || !selected) return null;
      return { workspaceRoot: await validateWorkspaceRoot(selected) };
    },
  );

  ipcMain.handle(
    IpcChannels.AgentStartSession,
    async (event, raw: unknown): Promise<AgentStartSessionResponse> => {
      const req = AgentStartSessionRequestSchema.parse(raw);
      const sender = event.sender;
      // sink：webContents 包装。窗口销毁后静默丢弃（会话清理由 before-quit / abort 兜底）
      const sessionId = await agent.startSession(req, {
        send: (agentEvent) => {
          if (!sender.isDestroyed()) {
            sender.send(IpcChannels.AgentEvent, agentEvent);
          }
        },
      });
      return { sessionId, resumable: agent.isSessionResumable(sessionId) };
    },
  );

  ipcMain.handle(IpcChannels.AgentSend, async (_event, raw: unknown): Promise<void> => {
    const req = AgentSendRequestSchema.parse(raw);
    agent.send(req.sessionId, req.message);
  });

  ipcMain.handle(IpcChannels.AgentAbort, async (_event, raw: unknown): Promise<void> => {
    const req = AgentAbortRequestSchema.parse(raw);
    agent.abort(req.sessionId);
  });

  ipcMain.handle(
    IpcChannels.AgentHermesInteractionResponse,
    async (event, raw: unknown): Promise<boolean> => {
      return agent.respondHermesInteraction(raw, event.sender.id);
    },
  );

  // ----- profiles -----

  ipcMain.handle(IpcChannels.AgentProfilesList, async (): Promise<ProviderProfile[]> => {
    return agent.listProfiles();
  });

  ipcMain.handle(
    IpcChannels.AgentProfilesSave,
    async (_event, raw: unknown): Promise<ProviderProfile> => {
      const req = AgentProfileSaveRequestSchema.parse(raw);
      // profile 形态校验（ProviderProfileSchema）在 domain 归属包做，shared 不重复定义
      const profile = ProviderProfileSchema.parse(req.profile);
      return agent.saveProfile(profile, req.credential);
    },
  );

  ipcMain.handle(IpcChannels.AgentProfilesDelete, async (_event, raw: unknown): Promise<void> => {
    const req = AgentProfileDeleteRequestSchema.parse(raw);
    await agent.deleteProfile(req.id);
  });

  // 会话历史：列表 + 回放
  ipcMain.handle(IpcChannels.AgentSessionsList, async (): Promise<AgentSessionMeta[]> => {
    return agent.listSessions();
  });

  ipcMain.handle(IpcChannels.AgentSessionLoad, async (_event, raw: unknown): Promise<unknown[]> => {
    const req = AgentSessionLoadRequestSchema.parse(raw);
    return agent.loadSessionEvents(req.sessionId);
  });

  ipcMain.handle(
    IpcChannels.AgentSessionOpen,
    async (event, raw: unknown): Promise<AgentSessionOpenResponse> => {
      const req = AgentSessionOpenRequestSchema.parse(raw);
      const sender = event.sender;
      return agent.openSession(req.sessionId, {
        send: (agentEvent) => {
          if (!sender.isDestroyed()) sender.send(IpcChannels.AgentEvent, agentEvent);
        },
      });
    },
  );
}
