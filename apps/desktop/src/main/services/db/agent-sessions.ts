// AgentSessionService：agent_sessions 表（会话元数据）。
// 供侧栏「任务」历史列表 + 标题展示。会话内容在 agent_events（含用户消息）。

import type { AgentSessionStatus } from "@opentrad/shared";
import type Database from "better-sqlite3";

export interface AgentSessionRow {
  sessionId: string;
  title: string | null;
  model: string | null;
  createdAt: number;
  profileId?: string;
  workspaceRoot?: string;
  status?: AgentSessionStatus;
  resumable?: boolean;
}

interface AgentSessionRawRow {
  session_id: string;
  title: string | null;
  model: string | null;
  created_at: number;
  profile_id: string | null;
  workspace_root: string | null;
  status: AgentSessionStatus | null;
  resumable: number | null;
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
    this.stmtList = db.prepare(
      `SELECT sessions.*, bindings.profile_id, bindings.workspace_root,
              bindings.status, bindings.resumable
       FROM agent_sessions AS sessions
       LEFT JOIN agent_runtime_bindings AS bindings USING (session_id)
       ORDER BY sessions.created_at DESC LIMIT 100`,
    );
    this.stmtGet = db.prepare<[string]>(
      `SELECT sessions.*, bindings.profile_id, bindings.workspace_root,
              bindings.status, bindings.resumable
       FROM agent_sessions AS sessions
       LEFT JOIN agent_runtime_bindings AS bindings USING (session_id)
       WHERE sessions.session_id = ?`,
    );
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
  const row: AgentSessionRow = {
    sessionId: raw.session_id,
    title: raw.title,
    model: raw.model,
    createdAt: raw.created_at,
  };
  if (
    raw.profile_id !== null &&
    raw.workspace_root !== null &&
    raw.status !== null &&
    raw.resumable !== null
  ) {
    row.profileId = raw.profile_id;
    row.workspaceRoot = raw.workspace_root;
    row.status = raw.status;
    row.resumable = raw.resumable === 1;
  }
  return row;
}
