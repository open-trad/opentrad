import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/main/services/db/init";
import {
  fingerprintDatabaseSchema,
  inspectDatabaseForMigration,
} from "../../src/main/services/db/migration-inspection";
import { SCHEMA_SQL } from "../../src/main/services/db/schema";

describe("database v2 migration", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function databasePath(): string {
    const directory = mkdtempSync(join(tmpdir(), "opentrad-db-migration-"));
    temporaryDirectories.push(directory);
    return join(directory, "opentrad.db");
  }

  it("migrates the reviewed current-v1 schema to v2 without losing agent session rows", () => {
    const path = databasePath();
    const legacy = new Database(path);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(SCHEMA_SQL);
    legacy.exec(
      "DROP INDEX idx_agent_runtime_bindings_durable; DROP TABLE agent_runtime_bindings;",
    );
    legacy
      .prepare(
        "INSERT INTO agent_sessions (session_id, title, model, created_at) VALUES (?, ?, ?, ?)",
      )
      .run("legacy-session", "Legacy", "deepseek-chat", 1);
    legacy
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("schema_version", "1", 1);
    expect(inspectDatabaseForMigration(legacy).kind).toBe("current-v1");
    expect(legacy.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get()).toEqual(
      { value: "1" },
    );
    legacy.close();

    const migrated = openDatabase({ dbPath: path });
    expect(inspectDatabaseForMigration(migrated).kind).toBe("current-v2");
    expect(
      migrated
        .prepare("SELECT title FROM agent_sessions WHERE session_id = ?")
        .get("legacy-session"),
    ).toEqual({ title: "Legacy" });
    expect(
      migrated.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get(),
    ).toEqual({ value: "2" });
    migrated.close();

    const reopened = openDatabase({ dbPath: path });
    expect(inspectDatabaseForMigration(reopened).kind).toBe("current-v2");
    reopened.close();
  });

  it("rejects an unknown physical schema before making any migration writes", () => {
    const path = databasePath();
    const unknown = new Database(path);
    unknown.exec(SCHEMA_SQL);
    unknown.exec("CREATE TABLE unexpected_drift (secret TEXT)");
    expect(unknown.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
    const before = fingerprintDatabaseSchema(unknown);
    unknown.close();

    expect(() => openDatabase({ dbPath: path })).toThrowError(
      expect.objectContaining({ code: "DB_MIGRATION_SCHEMA_UNKNOWN" }),
    );

    const unchanged = new Database(path);
    expect(unchanged.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(fingerprintDatabaseSchema(unchanged)).toBe(before);
    expect(
      unchanged.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get("unexpected_drift"),
    ).toEqual({ name: "unexpected_drift" });
    unchanged.close();
  });
});
