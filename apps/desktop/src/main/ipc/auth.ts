// auth:* + shell:* IPC handlers(M1 #22)。
//
// auth:start-login-flow:主进程 spawn `claude auth login --claudeai|--apiKey <K>`(PTY)
//   返回 ptyId 给 renderer。PTY 输出走 #20 的 PtyData / PtyExit 路由到 renderer
//   (LoginStep 用同款订阅模式 + 自己 regex 提取 URL)。
// shell:open-external:主进程用 electron shell.openExternal 打开 URL(系统默认浏览器)。
//   URL 必须是 http(s),其他 scheme zod 拒(避免 file:// 等漏洞)。
//
// renderer 取消登录:调 pty:kill(已存在的 #20 channel)kill ptyId,无需新 channel。

import {
  type AuthStartLoginFlowRequest,
  AuthStartLoginFlowRequestSchema,
  type AuthStartLoginFlowResponse,
  type HermesOAuthStartRequest,
  HermesOAuthStartRequestSchema,
  type HermesOAuthStartResponse,
  HermesOAuthStartResponseSchema,
  IpcChannels,
  type ShellOpenExternalRequest,
  ShellOpenExternalRequestSchema,
} from "@opentrad/shared";
import { ipcMain, shell } from "electron";
import { getApiKeyLoginCommand, getClaudeAiLoginCommand } from "../services/auth-login";
import type { HermesOAuthPtyCoordinator } from "../services/hermes/oauth-login";
import type { PtyManager } from "../services/pty-manager";
import type { PtySubscriberRouter } from "../services/pty-subscriber-router";

export interface AuthHandlerDeps {
  pty: PtyManager;
  ptyRouter: PtySubscriberRouter;
  hermesOAuth: HermesOAuthPtyCoordinator;
}

export function registerAuthHandlers(deps: AuthHandlerDeps): void {
  const { ptyRouter, hermesOAuth } = deps;

  ipcMain.handle(
    IpcChannels.AuthStartLoginFlow,
    async (event, raw: unknown): Promise<AuthStartLoginFlowResponse> => {
      const req: AuthStartLoginFlowRequest = AuthStartLoginFlowRequestSchema.parse(raw ?? {});

      const cmd =
        req.method === "apikey"
          ? getApiKeyLoginCommand(req.apiKey ?? "")
          : getClaudeAiLoginCommand();

      const ptyId = ptyRouter.spawnAndBind(
        {
          command: cmd.command,
          args: cmd.args,
        },
        event.sender,
      );
      // PTY 输出已通过 #20 的 PtyData / PtyExit 事件路由到 renderer
      // (LoginStep 用 TerminalPane + 自己 regex 提取 URL)
      return { ptyId };
    },
  );

  ipcMain.handle(
    IpcChannels.AuthStartHermesOAuth,
    async (event, raw: unknown): Promise<HermesOAuthStartResponse> => {
      const req: HermesOAuthStartRequest = HermesOAuthStartRequestSchema.parse(raw);
      const response = await hermesOAuth.start(req.profileId, event.sender);
      return HermesOAuthStartResponseSchema.parse(response);
    },
  );

  ipcMain.handle(IpcChannels.ShellOpenExternal, async (_event, raw: unknown): Promise<void> => {
    const req: ShellOpenExternalRequest = ShellOpenExternalRequestSchema.parse(raw);
    // shell.openExternal 在主进程执行,renderer 不能直拿;额外护栏:zod 已校 url(),
    // 这里再守一道 protocol 白名单,避免 javascript: / file: 等被构造绕过
    const u = new URL(req.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`shell:open-external rejected non-http(s) protocol: ${u.protocol}`);
    }
    await shell.openExternal(req.url);
  });
}
