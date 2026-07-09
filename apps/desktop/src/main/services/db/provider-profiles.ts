// ProviderProfileService：provider_profiles 表（JSON 列）。
// 本服务只管持久化，不感知 profile 内部形态——JSON.parse 后原样返回 unknown，
// zod 校验（ProviderProfileSchema）由消费方（agent-service 的 ProfileRegistry）做。
// 这样 db 层不依赖 @opentrad/model-providers，保持单向依赖。

import type Database from "better-sqlite3";

interface ProviderProfileRawRow {
  id: string;
  json: string;
  updated_at: number;
}

export class ProviderProfileService {
  private readonly stmtUpsert;
  private readonly stmtList;
  private readonly stmtDelete;

  constructor(db: Database.Database) {
    this.stmtUpsert = db.prepare<[string, string, number]>(
      `INSERT INTO provider_profiles (id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
    );
    this.stmtList = db.prepare(`SELECT * FROM provider_profiles ORDER BY updated_at ASC`);
    this.stmtDelete = db.prepare<[string]>(`DELETE FROM provider_profiles WHERE id = ?`);
  }

  save(id: string, profile: unknown): void {
    this.stmtUpsert.run(id, JSON.stringify(profile), Date.now());
  }

  // 返回 unknown[]：JSON.parse 失败的行跳过（脏数据保护，不让单行坏数据炸掉整个列表）
  listRaw(): unknown[] {
    const rows = this.stmtList.all() as ProviderProfileRawRow[];
    const result: unknown[] = [];
    for (const row of rows) {
      try {
        result.push(JSON.parse(row.json));
      } catch {
        console.error(`[provider-profiles] skipping corrupted profile row: ${row.id}`);
      }
    }
    return result;
  }

  delete(id: string): void {
    this.stmtDelete.run(id);
  }
}
