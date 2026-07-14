// 数据库打开 + 初始化建表 + schema_version 写入。
// 设计：
// - 同步 API（better-sqlite3，按 ADR-004）
// - foreign_keys ON（events.session_id 外键依赖）
// - journal_mode = DELETE（不用 WAL；单写者足够，避免 -wal/-shm 残留 + 应用退出时干净 close）
// - schema_version 通过 settings 表记录，预留 M2 迁移机制（M1 不实现迁移）
// - 支持 ":memory:" 用于单元测试

import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { inspectDatabaseForMigration } from "./migration-inspection";
import { getDbPath, getUserDataDir } from "./paths";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

export interface OpenDbOptions {
  // 显式指定 db 文件路径；不传时用 getDbPath()。":memory:" 启用 in-memory 模式（单测用）。
  dbPath?: string;
}

export function openDatabase(opts: OpenDbOptions = {}): Database.Database {
  const dbPath = opts.dbPath ?? getDbPath();

  // 文件路径需要确保父目录存在；in-memory 跳过
  if (dbPath !== ":memory:") {
    mkdirSync(getUserDataDir(), { recursive: true });
  }

  const db = new Database(dbPath);
  try {
    // Inspect before persistent pragmas. In particular, journal_mode would mutate an
    // unknown WAL database even if the physical schema is rejected immediately after.
    inspectDatabaseForMigration(db);
    db.pragma("foreign_keys = ON");

    db.exec("BEGIN IMMEDIATE");
    try {
      // The first inspection prevents any write against an already-unknown DB. The
      // second closes the check-to-write race after the SQLite write lock is held.
      inspectDatabaseForMigration(db, { transaction: "required" });
      db.exec(SCHEMA_SQL);
      ensureSchemaVersion(db);
      if (inspectDatabaseForMigration(db, { transaction: "required" }).kind !== "current-v2") {
        throw new Error("Database migration did not reach the expected schema");
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.inTransaction) db.exec("ROLLBACK");
      throw error;
    }

    // journal_mode is persistent, so switch it only after the reviewed migration
    // committed. Rejected schemas keep their original journal mode and bytes.
    db.pragma("journal_mode = DELETE");

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function ensureSchemaVersion(db: Database.Database): void {
  // Physical-schema inspection is authoritative; this row is informational and is
  // normalized only after the reviewed migration succeeds.
  const stmt = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  stmt.run("schema_version", JSON.stringify(SCHEMA_VERSION), Date.now());
}
