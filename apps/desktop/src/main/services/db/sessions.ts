// SessionService：sessions 表 CRUD。
// row 列 snake_case ↔ domain 字段 camelCase 在本服务做显式映射（沿用 D1 wire/domain 风格）。
// CASCADE：FK 配置 ON DELETE CASCADE，删 session 时关联 events 自动清理。

import {
  type ListPagination,
  type SessionCreateInput,
  type SessionRow,
  SessionRowSchema,
  type SessionStatus,
} from "@opentrad/shared";
import type Database from "better-sqlite3";

interface SessionRawRow {
  id: string;
  title: string;
  skill_id: string | null;
  cc_session_path: string | null;
  created_at: number;
  updated_at: number;
  last_model: string | null;
  total_cost_usd: number;
  message_count: number;
  status: string;
}

function toDomain(raw: SessionRawRow): SessionRow {
  return SessionRowSchema.parse({
    id: raw.id,
    title: raw.title,
    skillId: raw.skill_id,
    ccSessionPath: raw.cc_session_path,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    lastModel: raw.last_model,
    totalCostUsd: raw.total_cost_usd,
    messageCount: raw.message_count,
    status: raw.status,
  });
}

export class SessionService {
  private readonly stmtCreate;
  private readonly stmtGet;
  private readonly stmtList;
  private readonly stmtUpdateStatus;
  private readonly stmtUpdateMeta;
  private readonly stmtDelete;
  private readonly stmtCount;

  constructor(db: Database.Database) {
    this.stmtCreate = db.prepare(
      `INSERT INTO sessions (id, title, skill_id, cc_session_path, created_at, updated_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtGet = db.prepare<[string]>(`SELECT * FROM sessions WHERE id = ?`);
    this.stmtList = db.prepare<[number, number]>(
      `SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    );
    this.stmtUpdateStatus = db.prepare<[string, number, string]>(
      `UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`,
    );
    this.stmtUpdateMeta = db.prepare<[number, string | null, number, number, string]>(
      `UPDATE sessions
       SET updated_at = ?, last_model = ?, total_cost_usd = ?, message_count = ?
       WHERE id = ?`,
    );
    this.stmtDelete = db.prepare<[string]>(`DELETE FROM sessions WHERE id = ?`);
    this.stmtCount = db.prepare(`SELECT COUNT(*) AS c FROM sessions`);
  }

  create(input: SessionCreateInput): SessionRow {
    const now = Date.now();
    this.stmtCreate.run(
      input.id,
      input.title,
      input.skillId ?? null,
      input.ccSessionPath ?? null,
      now,
      now,
      input.status,
    );
    const created = this.get(input.id);
    if (!created) {
      throw new Error(`SessionService.create: row not found after insert (id=${input.id})`);
    }
    return created;
  }

  get(id: string): SessionRow | undefined {
    const raw = this.stmtGet.get(id) as SessionRawRow | undefined;
    return raw ? toDomain(raw) : undefined;
  }

  list(pagination: ListPagination): SessionRow[] {
    const rows = this.stmtList.all(pagination.limit, pagination.offset) as SessionRawRow[];
    return rows.map(toDomain);
  }

  count(): number {
    return (this.stmtCount.get() as { c: number }).c;
  }

  updateStatus(id: string, status: SessionStatus): void {
    this.stmtUpdateStatus.run(status, Date.now(), id);
  }

  // 任务结束时更新 cost/usage 元数据（M1 #9 接通 sessionStore.startTask 时使用）
  updateMeta(
    id: string,
    meta: { lastModel?: string | null; totalCostUsd: number; messageCount: number },
  ): void {
    this.stmtUpdateMeta.run(
      Date.now(),
      meta.lastModel ?? null,
      meta.totalCostUsd,
      meta.messageCount,
      id,
    );
  }

  // events 通过 FK ON DELETE CASCADE 自动清理
  delete(id: string): void {
    this.stmtDelete.run(id);
  }
}
