// AgentSessionService：agent_sessions 表（会话元数据）。
// 供侧栏「任务」历史列表 + 标题展示。会话内容在 agent_events（含用户消息）。

import type Database from "better-sqlite3";

export interface AgentSessionRow {
  sessionId: string;
  title: string | null;
  model: string | null;
  createdAt: number;
}

interface AgentSessionRawRow {
  session_id: string;
  title: string | null;
  model: string | null;
  created_at: number;
}

export class AgentSessionService {
  private readonly stmtCreate;
  private readonly stmtSetTitleIfEmpty;
  private readonly stmtList;
  private readonly stmtGet;
  private readonly stmtDelete;

  constructor(db: Database.Database) {
    this.stmtCreate = db.prepare<[string, string | null, number]>(
      `INSERT OR IGNORE INTO agent_sessions (session_id, model, created_at) VALUES (?, ?, ?)`,
    );
    // 仅当标题为空时写入（首条用户消息设为标题，后续消息不覆盖）
    this.stmtSetTitleIfEmpty = db.prepare<[string, string]>(
      `UPDATE agent_sessions SET title = ? WHERE session_id = ? AND (title IS NULL OR title = '')`,
    );
    this.stmtList = db.prepare(`SELECT * FROM agent_sessions ORDER BY created_at DESC LIMIT 100`);
    this.stmtGet = db.prepare<[string]>(`SELECT * FROM agent_sessions WHERE session_id = ?`);
    this.stmtDelete = db.prepare<[string]>(`DELETE FROM agent_sessions WHERE session_id = ?`);
  }

  create(sessionId: string, model: string | null, createdAt: number): void {
    this.stmtCreate.run(sessionId, model, createdAt);
  }

  setTitleIfEmpty(sessionId: string, title: string): void {
    this.stmtSetTitleIfEmpty.run(title, sessionId);
  }

  list(): AgentSessionRow[] {
    return (this.stmtList.all() as AgentSessionRawRow[]).map(mapRow);
  }

  get(sessionId: string): AgentSessionRow | undefined {
    const raw = this.stmtGet.get(sessionId) as AgentSessionRawRow | undefined;
    return raw ? mapRow(raw) : undefined;
  }

  delete(sessionId: string): void {
    this.stmtDelete.run(sessionId);
  }
}

function mapRow(raw: AgentSessionRawRow): AgentSessionRow {
  return {
    sessionId: raw.session_id,
    title: raw.title,
    model: raw.model,
    createdAt: raw.created_at,
  };
}
