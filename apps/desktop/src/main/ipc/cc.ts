// cc:* IPC handlers。对应 03-architecture.md §3 IPC channels + §4.1 Process Manager。
//
// M0 范围：cc:status / cc:start-task hardcoded demo / cc:cancel-task / cc:event 推送。
// **M1 #26 接通完整链路**（替换 M0 hardcoded prompt + 空 mcp-config）：
//   1. SkillLoader.load(skillId) → manifest（M1 #26 用 fixture loader 占位，#23 替换）
//   2. PromptComposer.compose(manifest, inputs) → fullPrompt（同上）
//   3. McpConfigWriter.generateForSession(sessionId, manifest) → configPath
//   4. SessionService.create + EventService append（A4 ownership）
//   5. CCManager.startTask({ sessionId, prompt, mcpConfigPath, allowedTools })
//   6. for-await events → 先 EventService.append（持久化）→ 再 webContents.send 推 renderer
//   7. result 事件到达后：McpConfigWriter.cleanup + SessionService.updateMeta + updateStatus completed

import { randomUUID } from "node:crypto";
import { type CCManager, redactEmail } from "@opentrad/cc-adapter";
import {
  type CCCancelTaskRequest,
  type CCStartTaskRequest,
  CCStartTaskRequestSchema,
  type CCStartTaskResponse,
  type CCStatus,
  IpcChannels,
} from "@opentrad/shared";
import { ipcMain } from "electron";
import type { DbServices } from "../services/db";
import type { McpConfigWriter } from "../services/mcp-writer";
import { composePrompt, loadFixtureSkill } from "../services/skill-fixture-loader";

export interface CcHandlerDeps {
  manager: CCManager;
  db: DbServices;
  mcpWriter: McpConfigWriter;
}

export function registerCcHandlers(deps: CcHandlerDeps): void {
  const { manager, db, mcpWriter } = deps;

  ipcMain.handle(IpcChannels.CCStatus, async (): Promise<CCStatus> => {
    return buildCcStatus(manager);
  });

  ipcMain.handle(
    IpcChannels.CCStartTask,
    async (event, raw: unknown): Promise<CCStartTaskResponse> => {
      const req: CCStartTaskRequest = CCStartTaskRequestSchema.parse(raw);

      // 1-2. 加载 skill manifest + 组装 prompt
      // M1 #26 用 fixture loader 占位（packages/skill-runtime/__fixtures__/）。
      // M1 #23 (#open-trad/opentrad#23) 真做 SkillLoader 后切换到
      // import { SkillLoader, PromptComposer } from "@opentrad/skill-runtime"。
      const loaded = loadFixtureSkill(req.skillId);
      const fullPrompt = composePrompt(loaded, req.inputs);
      const { manifest } = loaded;

      const sessionId = randomUUID();

      // 3. 生成临时 mcp-config（McpConfigWriter）
      const mcpConfigPath = mcpWriter.generateForSession(sessionId, manifest);

      // 4. session 行写入（status='active'）；events 表 append ownership 在第 6 步
      db.sessions.create({
        id: sessionId,
        title: titleFromInputs(manifest.id, req.inputs),
        skillId: manifest.id,
        status: "active",
      });

      // 5. spawn CC + allowedTools 透传
      const handle = await manager.startTask({
        sessionId,
        prompt: fullPrompt,
        mcpConfigPath,
        allowedTools: manifest.allowedTools,
      });

      // 6-7. 事件流：先 events.append（A4 ownership），再推 renderer；
      //      result 事件做收尾（cleanup + updateMeta + status completed）。
      let seq = 0;
      let lastModel: string | null = null;
      let messageCount = 0;
      let totalCost = 0;

      void (async () => {
        try {
          for await (const evt of handle.events) {
            // **A4 events append ownership 落地点（#19 issue body 强调）**
            db.events.append({
              sessionId,
              seq: seq++,
              type: evt.type,
              payload: evt,
            });

            // 计数 / 取最后 model（用于 sessions.updateMeta）
            if (evt.type === "assistant_text" || evt.type === "assistant_thinking") {
              messageCount++;
              if (evt.messageMeta?.model) lastModel = evt.messageMeta.model;
            }

            if (!event.sender.isDestroyed()) {
              event.sender.send(IpcChannels.CCEvent, evt);
            }

            if (evt.type === "result") {
              totalCost = evt.data.totalCostUsd;
              db.sessions.updateMeta(sessionId, {
                lastModel,
                totalCostUsd: totalCost,
                messageCount,
              });
              db.sessions.updateStatus(
                sessionId,
                evt.subtype === "success" ? "completed" : "error",
              );
            }
          }
        } catch (err) {
          console.error("[cc:event] stream error", err);
          db.sessions.updateStatus(sessionId, "error");
        } finally {
          mcpWriter.cleanup(sessionId);
        }
      })();

      return { sessionId };
    },
  );

  ipcMain.handle(
    IpcChannels.CCCancelTask,
    async (_event, req: CCCancelTaskRequest): Promise<void> => {
      const handle = manager.activeTasks.get(req.sessionId);
      if (handle) await handle.cancel();
    },
  );
}

// 合成 CCStatus：detectInstallation + getAuthStatus 两步的合并视图。
// 任一失败时把原因塞到 error 字段返回（不 throw，IPC 永远成功）。
export async function buildCcStatus(manager: CCManager): Promise<CCStatus> {
  try {
    const detected = await manager.detectInstallation();
    if (!detected.installed) {
      return {
        installed: false,
        error: detected.error,
      };
    }

    let loggedIn = false;
    let email: string | undefined;
    let authMethod: "subscription" | "api_key" | undefined;
    let authError: string | undefined;

    try {
      const auth = await manager.getAuthStatus();
      loggedIn = auth.loggedIn;
      authMethod = auth.method;
      email = auth.email ? redactEmail(auth.email) : undefined;
      authError = auth.error;
    } catch (err) {
      authError = err instanceof Error ? err.message : String(err);
    }

    return {
      installed: true,
      version: detected.version,
      loggedIn,
      email,
      authMethod,
      error: authError,
    };
  } catch (err) {
    return {
      installed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 从 inputs 拼一个简短 session 标题（最多 60 字符）。
// "fixture-skill: OpenTrad fixture run" 这种形态。
function titleFromInputs(skillId: string, inputs: Record<string, unknown>): string {
  const firstValue = Object.values(inputs).find(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const summary = firstValue ? firstValue.slice(0, 40) : "(no input)";
  return `${skillId}: ${summary}`;
}
