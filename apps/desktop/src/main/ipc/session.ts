// session:* IPC handlers。对应 03-architecture.md §5 sessions 表 + §3 IPC 协议。
// 实现范围（M1 #19 / #2）：
// - session:list（分页 limit/offset）→ SessionMeta[] 精简视图
// - session:get → SessionRow 完整视图（M1 #29 / #12 历史回放查 lastModel / totalCostUsd 用）
// - session:delete → 删 session（events FK CASCADE 自动清理）
//
// session:resume 在 M1 #29 / #12 落地（D-M1-7：M1 只查看 events 回放，不重启 CC 子进程）。

import {
  type CCEvent,
  IpcChannels,
  type SessionDeleteRequest,
  SessionDeleteRequestSchema,
  type SessionGetRequest,
  SessionGetRequestSchema,
  type SessionListRequest,
  SessionListRequestSchema,
  type SessionMeta,
  type SessionResumeRequest,
  SessionResumeRequestSchema,
  type SessionResumeResponse,
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
    db.sessions.delete((SessionDeleteRequestSchema.parse(raw) as SessionDeleteRequest).sessionId);
  });

  // M1 #29 D-M1-7:历史回放,返回 session meta + events 完整数组(payload 已 normalize 后 CCEvent)。
  // 不重启 CC 子进程,renderer 端只渲染 read-only。
  ipcMain.handle(
    IpcChannels.SessionResume,
    async (_event, raw: unknown): Promise<SessionResumeResponse | null> => {
      const req: SessionResumeRequest = SessionResumeRequestSchema.parse(raw);
      const session = db.sessions.get(req.sessionId);
      if (!session) return null;
      const eventRows = db.events.readBySession(req.sessionId);
      // payload 是 string(JSON),parse 还原为 CCEvent。失败的 row 跳过(M1 友好,
      // M2 视情况显式标"残缺事件")。
      const events: CCEvent[] = [];
      for (const row of eventRows) {
        try {
          const parsed = JSON.parse(row.payload as string) as CCEvent;
          events.push(parsed);
        } catch (err) {
          console.warn(`[session:resume] skip malformed event row id=${row.seq}`, err);
        }
      }
      return { session: toMeta(session), events };
    },
  );
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
