// AgentEventService：agent_events 表 append + 按 session 回放。
// 与旧 EventService（CCEvent 用 events 表）平行，互不影响（ADR-001：AgentEvent 是
// 自建 loop 的原生事件流；desktop 持久化/回放统一消费）。
// payload 存 JSON 字符串；读出时不解析（沿 EventService 惯例，消费方自行处理）。

import type Database from "better-sqlite3";

export interface AgentEventAppendInput {
  sessionId: string;
  seq: number;
  type: string;
  payload: unknown;
  timestamp?: number;
}

export interface AgentEventRow {
  id: number;
  sessionId: string;
  seq: number;
  type: string;
  payload: string; // JSON string
  timestamp: number;
}

interface AgentEventRawRow {
  id: number;
  session_id: string;
  seq: number;
  type: string;
  payload: string;
  timestamp: number;
}

export class AgentEventService {
  private readonly stmtAppend;
  private readonly stmtReadBySession;

  constructor(db: Database.Database) {
    this.stmtAppend = db.prepare<[string, number, string, string, number]>(
      `INSERT INTO agent_events (session_id, seq, type, payload, timestamp) VALUES (?, ?, ?, ?, ?)`,
    );
    this.stmtReadBySession = db.prepare<[string]>(
      `SELECT * FROM agent_events WHERE session_id = ? ORDER BY seq ASC`,
    );
  }

  append(input: AgentEventAppendInput): void {
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

  readBySession(sessionId: string): AgentEventRow[] {
    const rows = this.stmtReadBySession.all(sessionId) as AgentEventRawRow[];
    return rows.map((raw) => ({
      id: raw.id,
      sessionId: raw.session_id,
      seq: raw.seq,
      type: raw.type,
      payload: raw.payload,
      timestamp: raw.timestamp,
    }));
  }
}
