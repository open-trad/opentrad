// InstalledSkillService：installed_skills 表 CRUD。
// enabled INTEGER 0/1 ↔ boolean 在本服务做转换。

import {
  type InstalledSkillInstallInput,
  type InstalledSkillRow,
  InstalledSkillRowSchema,
} from "@opentrad/shared";
import type Database from "better-sqlite3";

interface InstalledSkillRawRow {
  id: string;
  source: string;
  version: string;
  install_path: string;
  enabled: number; // 0/1
  installed_at: number;
}

function toDomain(raw: InstalledSkillRawRow): InstalledSkillRow {
  return InstalledSkillRowSchema.parse({
    id: raw.id,
    source: raw.source,
    version: raw.version,
    installPath: raw.install_path,
    enabled: raw.enabled === 1,
    installedAt: raw.installed_at,
  });
}

export class InstalledSkillService {
  private readonly stmtList;
  private readonly stmtGet;
  private readonly stmtInsert;
  private readonly stmtSetEnabled;
  private readonly stmtDelete;

  constructor(db: Database.Database) {
    this.stmtList = db.prepare(`SELECT * FROM installed_skills ORDER BY installed_at DESC`);
    this.stmtGet = db.prepare<[string]>(`SELECT * FROM installed_skills WHERE id = ?`);
    this.stmtInsert = db.prepare<[string, string, string, string, number, number]>(
      `INSERT INTO installed_skills (id, source, version, install_path, enabled, installed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         source = excluded.source,
         version = excluded.version,
         install_path = excluded.install_path,
         enabled = excluded.enabled`,
    );
    this.stmtSetEnabled = db.prepare<[number, string]>(
      `UPDATE installed_skills SET enabled = ? WHERE id = ?`,
    );
    this.stmtDelete = db.prepare<[string]>(`DELETE FROM installed_skills WHERE id = ?`);
  }

  list(): InstalledSkillRow[] {
    const rows = this.stmtList.all() as InstalledSkillRawRow[];
    return rows.map(toDomain);
  }

  get(id: string): InstalledSkillRow | undefined {
    const raw = this.stmtGet.get(id) as InstalledSkillRawRow | undefined;
    return raw ? toDomain(raw) : undefined;
  }

  // upsert 语义：用作"安装或更新到新版本"
  install(input: InstalledSkillInstallInput): InstalledSkillRow {
    this.stmtInsert.run(
      input.id,
      input.source,
      input.version,
      input.installPath,
      input.enabled ? 1 : 0,
      Date.now(),
    );
    const row = this.get(input.id);
    if (!row) {
      throw new Error(`InstalledSkillService.install: row not found after insert (id=${input.id})`);
    }
    return row;
  }

  enable(id: string): void {
    this.stmtSetEnabled.run(1, id);
  }

  disable(id: string): void {
    this.stmtSetEnabled.run(0, id);
  }

  delete(id: string): void {
    this.stmtDelete.run(id);
  }
}
