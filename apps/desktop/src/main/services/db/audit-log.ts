// AuditLogService：audit_log 表 append-only。
// 每次 RiskGate.check 都写一条（automated allow / deny / user 决策都写），保证可追溯。
//
// automated INTEGER 0/1 ↔ boolean 在本服务转换。
// paramsJson 是已脱敏的参数 JSON 字符串（脱敏在 RiskGate UI 侧做，service 不感知）。

import { type AuditLogAppendInput, type AuditLogRow, AuditLogRowSchema } from "@opentrad/shared";
import type Database from "better-sqlite3";

interface AuditLogRawRow {
  id: number;
  timestamp: number;
  session_id: string;
  skill_id: string | null;
  tool_name: string;
  business_action: string | null;
  params_json: string | null;
  decision: string;
  automated: number; // 0/1
  reason: string | null;
}

function toDomain(raw: AuditLogRawRow): AuditLogRow {
  return AuditLogRowSchema.parse({
    id: raw.id,
    timestamp: raw.timestamp,
    sessionId: raw.session_id,
    skillId: raw.skill_id,
    toolName: raw.tool_name,
    businessAction: raw.business_action,
    paramsJson: raw.params_json,
    decision: raw.decision,
    automated: raw.automated === 1,
    reason: raw.reason,
  });
}

export class AuditLogService {
  private readonly stmtAppend;
  private readonly stmtBySession;
  private readonly stmtByDateRange;
  private readonly stmtAll;
  private readonly stmtCount;

  constructor(db: Database.Database) {
    this.stmtAppend = db.prepare<
      [
        number,
        string,
        string | null,
        string,
        string | null,
        string | null,
        string,
        number,
        string | null,
      ]
    >(
      `INSERT INTO audit_log
        (timestamp, session_id, skill_id, tool_name, business_action, params_json, decision, automated, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtBySession = db.prepare<[string, number, number]>(
      `SELECT * FROM audit_log WHERE session_id = ?
       ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
    );
    this.stmtByDateRange = db.prepare<[number, number, number, number]>(
      `SELECT * FROM audit_log WHERE timestamp >= ? AND timestamp < ?
       ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
    );
    // M1 #28 阶段 4 settings/risk 子页:全表分页(timestamp DESC)+ 总数
    this.stmtAll = db.prepare<[number, number]>(
      `SELECT * FROM audit_log ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
    );
    this.stmtCount = db.prepare(`SELECT COUNT(*) as c FROM audit_log`);
  }

  append(input: AuditLogAppendInput): void {
    this.stmtAppend.run(
      input.timestamp ?? Date.now(),
      input.sessionId,
      input.skillId ?? null,
      input.toolName,
      input.businessAction ?? null,
      input.paramsJson ?? null,
      input.decision,
      input.automated ? 1 : 0,
      input.reason ?? null,
    );
  }

  queryBySession(sessionId: string, opts: { limit?: number; offset?: number } = {}): AuditLogRow[] {
    const rows = this.stmtBySession.all(
      sessionId,
      opts.limit ?? 50,
      opts.offset ?? 0,
    ) as AuditLogRawRow[];
    return rows.map(toDomain);
  }

  // [from, to) 半开区间，单位 unix ms
  queryByDateRange(
    from: number,
    to: number,
    opts: { limit?: number; offset?: number } = {},
  ): AuditLogRow[] {
    const rows = this.stmtByDateRange.all(
      from,
      to,
      opts.limit ?? 50,
      opts.offset ?? 0,
    ) as AuditLogRawRow[];
    return rows.map(toDomain);
  }

  // 全表分页(M1 #28 阶段 4 settings/risk audit log 表)
  queryAll(opts: { limit?: number; offset?: number } = {}): AuditLogRow[] {
    const rows = this.stmtAll.all(opts.limit ?? 50, opts.offset ?? 0) as AuditLogRawRow[];
    return rows.map(toDomain);
  }

  count(): number {
    const row = this.stmtCount.get() as { c: number };
    return row.c;
  }
}
