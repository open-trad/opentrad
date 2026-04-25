// RiskRuleService：risk_rules 表（"以后都允许 / 以后都拒绝" 规则）。
// 唯一索引由 COALESCE(skill_id, '') / COALESCE(tool_name, '') / COALESCE(business_action, '') 组合而成
// （见 schema.ts 的 idx_risk_rules_key）。upsert 语义用 ON CONFLICT 触发同样的 COALESCE key 来更新。
//
// findMatching：由 RiskGate（M1 #11 / #28）调用。给出当前 tool 调用的 skillId / toolName / businessAction，
// 找匹配规则。优先级在 RiskGate 内部决策，不在本 service。

import {
  type RiskRuleMatchQuery,
  type RiskRuleRow,
  RiskRuleRowSchema,
  type RiskRuleSaveInput,
} from "@opentrad/shared";
import type Database from "better-sqlite3";

interface RiskRuleRawRow {
  id: number;
  skill_id: string | null;
  tool_name: string | null;
  business_action: string | null;
  decision: string;
  created_at: number;
}

function toDomain(raw: RiskRuleRawRow): RiskRuleRow {
  return RiskRuleRowSchema.parse({
    id: raw.id,
    skillId: raw.skill_id,
    toolName: raw.tool_name,
    businessAction: raw.business_action,
    decision: raw.decision,
    createdAt: raw.created_at,
  });
}

export class RiskRuleService {
  private readonly stmtList;
  private readonly stmtFindExact;
  private readonly stmtSave;
  private readonly stmtDelete;

  constructor(db: Database.Database) {
    this.stmtList = db.prepare(`SELECT * FROM risk_rules ORDER BY created_at DESC`);
    // 用 IS 判等 nullable 字段（IS NULL 比 = NULL 健壮）
    this.stmtFindExact = db.prepare<[string | null, string | null, string | null]>(
      `SELECT * FROM risk_rules
       WHERE skill_id IS ? AND tool_name IS ? AND business_action IS ?
       LIMIT 1`,
    );
    this.stmtSave = db.prepare<[string | null, string | null, string | null, string, number]>(
      `INSERT INTO risk_rules (skill_id, tool_name, business_action, decision, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`,
    );
    this.stmtDelete = db.prepare<[number]>(`DELETE FROM risk_rules WHERE id = ?`);
  }

  list(): RiskRuleRow[] {
    return (this.stmtList.all() as RiskRuleRawRow[]).map(toDomain);
  }

  findMatching(query: RiskRuleMatchQuery): RiskRuleRow | undefined {
    const raw = this.stmtFindExact.get(
      query.skillId ?? null,
      query.toolName ?? null,
      query.businessAction ?? null,
    ) as RiskRuleRawRow | undefined;
    return raw ? toDomain(raw) : undefined;
  }

  save(input: RiskRuleSaveInput): RiskRuleRow {
    this.stmtSave.run(
      input.skillId ?? null,
      input.toolName ?? null,
      input.businessAction ?? null,
      input.decision,
      Date.now(),
    );
    const found = this.findMatching({
      skillId: input.skillId ?? null,
      toolName: input.toolName ?? null,
      businessAction: input.businessAction ?? null,
    });
    if (!found) {
      throw new Error(`RiskRuleService.save: row not found after upsert`);
    }
    return found;
  }

  delete(id: number): void {
    this.stmtDelete.run(id);
  }
}
