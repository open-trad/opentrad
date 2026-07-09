// SettingsService：settings 表 key-value 存储。
// value 在 SQLite 是 TEXT（JSON.stringify 后），domain 层是任意 unknown 值。
// 调用方应在自己侧用 zod 校验具体 key 的 value 形态（service 不感知 key 语义）。

import type Database from "better-sqlite3";

interface SettingsRawRow {
  key: string;
  value: string; // JSON-encoded
  updated_at: number;
}

export class SettingsService {
  private readonly stmtGet;
  private readonly stmtSet;
  private readonly stmtDelete;

  constructor(db: Database.Database) {
    this.stmtGet = db.prepare<[string]>(`SELECT * FROM settings WHERE key = ?`);
    this.stmtSet = db.prepare<[string, string, number]>(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.stmtDelete = db.prepare<[string]>(`DELETE FROM settings WHERE key = ?`);
  }

  get(key: string): unknown | undefined {
    const raw = this.stmtGet.get(key) as SettingsRawRow | undefined;
    if (!raw) return undefined;
    try {
      return JSON.parse(raw.value);
    } catch {
      // 历史脏数据保护：不抛异常，返回 undefined 让调用方走默认值路径
      return undefined;
    }
  }

  set(key: string, value: unknown): void {
    this.stmtSet.run(key, JSON.stringify(value), Date.now());
  }

  // 重置为指定值（语义等同 set，命名清晰用于"恢复默认"场景）
  reset(key: string, defaultValue: unknown): void {
    this.set(key, defaultValue);
  }

  delete(key: string): void {
    this.stmtDelete.run(key);
  }
}
