// EventService：events 表 append + 按 session 回放。
// payload 存为 JSON 字符串（service 层 JSON.stringify）。读出时不解析（消费方可能不需要 / 自己处理）。
//
// **append ownership 在 M1 #9 (#26)**（见 issue #18 close 评论 + #26 验收）：
// sessionStore.startTask 收到 cc:event 时，在推送 renderer 之前调用 EventService.append。
// 这样 #29 历史回放（features/history/HistoryList.tsx）可以直接 readBySession 渲染。

import { type EventAppendInput, type EventRow, EventRowSchema } from "@opentrad/shared";
import type Database from "better-sqlite3";

interface EventRawRow {
  id: number;
  session_id: string;
  seq: number;
  type: string;
  payload: string;
  timestamp: number;
}

function toDomain(raw: EventRawRow): EventRow {
  return EventRowSchema.parse({
    id: raw.id,
    sessionId: raw.session_id,
    seq: raw.seq,
    type: raw.type,
    payload: raw.payload,
    timestamp: raw.timestamp,
  });
}

export class EventService {
  private readonly stmtAppend;
  private readonly stmtReadBySession;
  private readonly stmtCountBySession;

  constructor(db: Database.Database) {
    this.stmtAppend = db.prepare<[string, number, string, string, number]>(
      `INSERT INTO events (session_id, seq, type, payload, timestamp) VALUES (?, ?, ?, ?, ?)`,
    );
    this.stmtReadBySession = db.prepare<[string]>(
      `SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC`,
    );
    this.stmtCountBySession = db.prepare<[string]>(
      `SELECT COUNT(*) AS c FROM events WHERE session_id = ?`,
    );
  }

  // payload 接受任意 unknown，service 层负责 JSON.stringify
  append(input: EventAppendInput): void {
    const payload =
      typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload);
    this.stmtAppend.run(
      input.sessionId,
      input.seq,
      input.type,
      payload,
      input.timestamp ?? Date.now(),
    );
  }

  readBySession(sessionId: string): EventRow[] {
    const rows = this.stmtReadBySession.all(sessionId) as EventRawRow[];
    return rows.map(toDomain);
  }

  countBySession(sessionId: string): number {
    return (this.stmtCountBySession.get(sessionId) as { c: number }).c;
  }
}
