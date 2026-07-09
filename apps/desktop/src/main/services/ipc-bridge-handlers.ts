// 4 个 IPC bridge RPC handler 的实现（M1 #25 → M1 #28 真实化）。
// 把 IpcBridgeServer 的 wire 协议层跟具体业务（SQLite / fs / RiskGate）解耦。
//
// **M1 #28 关键改动**：risk-gate.request mock 替换为真实 RiskGate.check（@opentrad/risk-gate）。
// wire schema **0 改动**（RiskGateRpcParams 仍是 RiskGateRequest）;sessionId 由 ctx 提供;
// stopBeforeList / category 在 desktop 端通过 resolveSkillContext 用 sessionId 查 skill manifest 补上。
//
// 4 个 RPC：
// - risk-gate.request：真实 RiskGate.check 4 步判断 → audit_log → 返回 RiskGateDecision
// - audit.log：直接走 AuditLogService.append（mcp-server 端独立 audit 调用）
// - draft.save：写 ~/.opentrad/drafts/{date}-{filename}.md
// - session.metadata：走 SessionService.get + 投影到 SessionMeta

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AuditLogRpcParams,
  DraftSaveRpcParams,
  DraftSaveRpcResult,
  RiskGateRpcParams,
  RiskGateRpcResult,
  SessionMetadataRpcParams,
  SessionMetadataRpcResult,
} from "@opentrad/shared";
import type { DbServices } from "./db";
import { getDraftsDir } from "./db/paths";
import type { IpcBridgeHandlers } from "./ipc-bridge-server";
import type { RiskGateBundle } from "./risk-gate";

export function createIpcBridgeHandlers(
  db: DbServices,
  riskGateBundle: RiskGateBundle,
): IpcBridgeHandlers {
  return {
    async riskGateRequest(
      params: RiskGateRpcParams,
      ctx: { sessionId: string },
    ): Promise<RiskGateRpcResult> {
      // sessionId 从 IPC bridge ctx 拿(由 hello 帧路由注入,与 wire 协议解耦)。
      // skillId / stopBeforeList 通过 resolveSkillContext 从 db.sessions + skill manifest 查。
      // graceful degrade(D-M1-5):查不到 skill context 时仍走 RiskGate(skillId=null,
      // 无 stopBeforeList,业务级判断会退化为纯工具级)。
      const skillContext = riskGateBundle.resolveSkillContext(ctx.sessionId);
      const result = await riskGateBundle.gate.check({
        sessionId: ctx.sessionId,
        skillId: skillContext.skillId ?? params.skillId, // bridge params 兜底
        toolName: params.toolName,
        riskLevel: params.riskLevel,
        params: params.params,
        stopBeforeList: skillContext.stopBeforeList,
        businessAction: params.businessAction,
      });
      // RiskGate.check 内部已写 audit_log;此处只投影 decision 到 wire schema
      return {
        decision: result.decision,
        reason: result.reason,
        timestamp: Date.now(),
      };
    },

    async auditLog(params: AuditLogRpcParams): Promise<void> {
      db.auditLog.append(params);
    },

    async draftSave(params: DraftSaveRpcParams): Promise<DraftSaveRpcResult> {
      const draftsDir = getDraftsDir();
      mkdirSync(draftsDir, { recursive: true });

      const today = isoDate(new Date());
      // 文件名脱掉路径分隔符，避免 ../ 写出 drafts 目录之外
      const safeName = sanitizeFilename(params.filename);
      const fullPath = join(draftsDir, `${today}-${safeName}`);
      writeFileSync(fullPath, params.content, "utf-8");
      return { path: fullPath };
    },

    async sessionMetadata(params: SessionMetadataRpcParams): Promise<SessionMetadataRpcResult> {
      const row = db.sessions.get(params.sessionId);
      if (!row) return null;
      return {
        id: row.id,
        title: row.title,
        skillId: row.skillId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        status: row.status,
      };
    },
  };
}

function isoDate(d: Date): string {
  // YYYY-MM-DD（不带时区，本地日期；草稿目录是用户本地文件，本地日期更友好）
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sanitizeFilename(name: string): string {
  // 移除路径分隔符 + 控制字符 + 头尾空格点。
  // 不强制保留 .md 后缀（让调用方决定）。
  let cleaned = name.replace(/[/\\\0\n\r]/g, "_").trim();
  // 防御 Windows 保留名（CON、PRN 等）+ 防 .. 路径穿越
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    cleaned = "draft";
  }
  return cleaned;
}
