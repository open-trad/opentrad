// session:* IPC handlers。对应 03-architecture.md §5 sessions 表 + §3 IPC 协议。
// 实现范围（M1 #19 / #2）：
// - session:list（分页 limit/offset）→ SessionMeta[] 精简视图
// - session:get → SessionRow 完整视图（M1 #29 / #12 历史回放查 lastModel / totalCostUsd 用）
// - session:delete → 删 session（events FK CASCADE 自动清理）
//
// session:resume 在 M1 #29 / #12 落地（D-M1-7：M1 只查看 events 回放，不重启 CC 子进程）。

import {
  IpcChannels,
  type SessionDeleteRequest,
  SessionDeleteRequestSchema,
  type SessionGetRequest,
  SessionGetRequestSchema,
  type SessionListRequest,
  SessionListRequestSchema,
  type SessionMeta,
  type SessionRow,
} from "@opentrad/shared";
import { ipcMain } from "electron";
import type { DbServices } from "../services/db";

export function registerSessionHandlers(db: DbServices): void {
  ipcMain.handle(IpcChannels.SessionList, async (_event, raw: unknown): Promise<SessionMeta[]> => {
    const req: SessionListRequest = SessionListRequestSchema.parse(raw ?? {});
    return db.sessions.list(req).map(toMeta);
  });

  ipcMain.handle(
    IpcChannels.SessionGet,
    async (_event, raw: unknown): Promise<SessionRow | null> => {
      const req: SessionGetRequest = SessionGetRequestSchema.parse(raw);
      return db.sessions.get(req.sessionId) ?? null;
    },
  );

  ipcMain.handle(IpcChannels.SessionDelete, async (_event, raw: unknown): Promise<void> => {
    const req: SessionDeleteRequest = SessionDeleteRequestSchema.parse(raw);
    db.sessions.delete(req.sessionId);
  });
}

function toMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    title: row.title,
    skillId: row.skillId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
  };
}
