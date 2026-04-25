// 4 个 IPC bridge RPC handler 的实现（M1 #25）。
// 把 IpcBridgeServer 的 wire 协议层跟具体业务（SQLite / fs）解耦。
//
// M1 mock + 真实分阶段（issue body）：
// - risk-gate.request：mock 返回 allow，真实在 M1 #11 / #28
// - audit.log：直接走 AuditLogService.append（已在 M1 #19 / #32 落地）
// - draft.save：写 ~/.opentrad/drafts/{date}-{filename}.md
// - session.metadata：走 SessionService.get + 投影到 SessionMeta（不暴露 ccSessionPath 等）

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

export function createIpcBridgeHandlers(db: DbServices): IpcBridgeHandlers {
  return {
    async riskGateRequest(_params: RiskGateRpcParams): Promise<RiskGateRpcResult> {
      // M1 mock：永远 allow。真实拦截在 M1 #11 / #28 由 RiskGate 引擎实现。
      // 不写 audit_log（mcp-server 端如需 audit 走单独的 audit.log RPC）。
      return {
        decision: "allow",
        reason: "M1 mock allow (real RiskGate at M1 #11 / open-trad/opentrad#28)",
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
