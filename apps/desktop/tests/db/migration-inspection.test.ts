import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DatabaseInspectionPort,
  DatabaseMigrationInspectionError,
  fingerprintDatabaseSchema,
  inspectDatabaseForMigration,
  KNOWN_DATABASE_SCHEMA_FINGERPRINTS,
  normalizeSchemaSql,
} from "../../src/main/services/db/migration-inspection";
import { SCHEMA_SQL } from "../../src/main/services/db/schema";

describe("database migration inspection", () => {
  const openDatabases: Database.Database[] = [];

  afterEach(() => {
    for (const db of openDatabases.splice(0)) {
      if (db.open) db.close();
    }
  });

  it("locks the empty physical schema to a reviewed literal", () => {
    const db = openMemoryDatabase(openDatabases);

    expect(fingerprintDatabaseSchema(db)).toBe(
      "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
    expect(inspectDatabaseForMigration(db)).toEqual({
      kind: "empty",
      fingerprint: KNOWN_DATABASE_SCHEMA_FINGERPRINTS.empty,
      objectCount: 0,
    });
  });

  it.each([
    [
      "legacy-core-v1",
      "legacy-core-v1" as const,
      "387c36f630629969bee2a0b5399b79e1cf06c94e72bdadc21f5a25ec72e8ab70",
      12,
    ],
    [
      "legacy-agent-v1",
      "legacy-agent-v1" as const,
      "f1c2943679a0eb245db9942cfa71054226e4c2ecd18c418449ed19ad88f9370a",
      16,
    ],
    [
      "current-v1",
      "current-v1" as const,
      "93bc4fdce92d08c60923c3157226ba7565504f0a032e87dccc18d5aad9a0d061",
      18,
    ],
  ])("recognizes the reviewed %s physical schema", (_label, kind, fingerprint, objectCount) => {
    const db = openMemoryDatabase(openDatabases);
    applyHistoricalShape(db, kind);

    expect(fingerprintDatabaseSchema(db)).toBe(fingerprint);
    expect(inspectDatabaseForMigration(db)).toEqual({ kind, fingerprint, objectCount });
  });

  it("does not use settings.schema_version as migration authority", () => {
    const db = openMemoryDatabase(openDatabases);
    db.exec(SCHEMA_SQL);
    const before = fingerprintDatabaseSchema(db);
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "schema_version",
      "999",
      1,
    );

    const inspection = inspectDatabaseForMigration(db);

    expect(inspection.kind).toBe("current-v1");
    expect(inspection.fingerprint).toBe(before);
  });

  it("keeps the physical fingerprint independent from business data", () => {
    const db = openMemoryDatabase(openDatabases);
    db.exec(SCHEMA_SQL);
    const before = fingerprintDatabaseSchema(db);
    db.prepare(
      `INSERT INTO sessions (
        id, title, created_at, updated_at, total_cost_usd, message_count, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("session-1", "LC_CANARY_SECRET", 1, 2, 0, 0, "active");
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "arbitrary",
      "value",
      3,
    );

    expect(fingerprintDatabaseSchema(db)).toBe(before);
    expect(inspectDatabaseForMigration(db).kind).toBe("current-v1");
  });

  it.each([
    ["extra table", "CREATE TABLE unexpected_drift (value TEXT)"],
    ["missing index", "DROP INDEX idx_sessions_updated"],
    ["changed columns", "ALTER TABLE sessions ADD COLUMN drift TEXT"],
  ])("rejects %s without mutating the unknown schema", (_label, driftSql) => {
    const db = openMemoryDatabase(openDatabases);
    db.exec(SCHEMA_SQL);
    db.exec(driftSql);
    const before = fingerprintDatabaseSchema(db);

    const error = captureInspectionError(() => inspectDatabaseForMigration(db));

    expect(error).toMatchObject({
      code: "DB_MIGRATION_SCHEMA_UNKNOWN",
      message: "Database schema is not recognized for migration",
    });
    expect(fingerprintDatabaseSchema(db)).toBe(before);
  });

  it("rejects foreign-key violations before schema classification", () => {
    const db = openMemoryDatabase(openDatabases);
    db.exec(SCHEMA_SQL);
    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO events (session_id, seq, type, payload, timestamp) VALUES (?, ?, ?, ?, ?)",
    ).run("missing-session", 1, "message", "{}", 1);

    const error = captureInspectionError(() => inspectDatabaseForMigration(db));

    expect(error).toMatchObject({
      code: "DB_MIGRATION_FOREIGN_KEY_FAILED",
      message: "Database foreign-key validation failed",
    });
  });

  it("rejects a non-ok integrity result with one frozen fixed error", () => {
    const port = fakeInspectionPort({
      integrity: [{ integrity_check: "LC_CANARY_SECRET" }],
    });

    const error = captureInspectionError(() => inspectDatabaseForMigration(port));

    expect(error).toBeInstanceOf(DatabaseMigrationInspectionError);
    expect(error).toMatchObject({
      code: "DB_MIGRATION_INTEGRITY_FAILED",
      message: "Database integrity validation failed",
    });
    expect(Object.isFrozen(error)).toBe(true);
    expect(JSON.stringify(error)).not.toContain("LC_CANARY_SECRET");
  });

  it("rejects an active transaction before issuing any pragma or schema query", () => {
    const port = fakeInspectionPort({ inTransaction: true });

    const error = captureInspectionError(() => inspectDatabaseForMigration(port));

    expect(error).toMatchObject({ code: "DB_MIGRATION_INSPECTION_UNAVAILABLE" });
    expect(port.calls).toEqual([]);
  });

  it("snapshots method getters before accepting the transaction state", () => {
    let inTransaction = false;
    const port = {
      get open(): boolean {
        return true;
      },
      get inTransaction(): boolean {
        return inTransaction;
      },
      pragma(source: string): unknown {
        return source === "integrity_check" ? [{ integrity_check: "ok" }] : [];
      },
      get prepare(): DatabaseInspectionPort["prepare"] {
        inTransaction = true;
        return () => ({ all: () => [] });
      },
    };

    const error = captureInspectionError(() => inspectDatabaseForMigration(port));

    expect(error).toMatchObject({
      code: "DB_MIGRATION_INSPECTION_UNAVAILABLE",
      message: "Database migration inspection is unavailable",
    });
  });

  it("rejects a closed connection and sanitizes query failures", () => {
    const closed = fakeInspectionPort({ open: false });
    expect(captureInspectionError(() => inspectDatabaseForMigration(closed))).toMatchObject({
      code: "DB_MIGRATION_INSPECTION_UNAVAILABLE",
    });

    const hostile = fakeInspectionPort({ prepareError: new Error("LC_CANARY_SECRET") });
    const error = captureInspectionError(() => fingerprintDatabaseSchema(hostile));
    expect(error).toMatchObject({
      code: "DB_MIGRATION_INSPECTION_UNAVAILABLE",
      message: "Database migration inspection is unavailable",
    });
    expect(JSON.stringify(error)).not.toContain("LC_CANARY_SECRET");
  });

  it("normalizes only unquoted whitespace and comments", () => {
    expect(
      normalizeSchemaSql(`
        CREATE  TABLE sample (
          value TEXT DEFAULT 'a  b', -- outside comment
          quoted TEXT DEFAULT "c  d" /* block comment */
        );
      `),
    ).toBe(`CREATE TABLE sample ( value TEXT DEFAULT 'a  b', quoted TEXT DEFAULT "c  d" )`);

    const first = openMemoryDatabase(openDatabases);
    const second = openMemoryDatabase(openDatabases);
    const changedLiteral = openMemoryDatabase(openDatabases);
    first.exec("CREATE TABLE sample (value TEXT CHECK(value = 'a  b'))");
    second.exec("CREATE   TABLE sample (value   TEXT CHECK(value = 'a  b'))");
    changedLiteral.exec("CREATE TABLE sample (value TEXT CHECK(value = 'a b'))");

    expect(fingerprintDatabaseSchema(second)).toBe(fingerprintDatabaseSchema(first));
    expect(fingerprintDatabaseSchema(changedLiteral)).not.toBe(fingerprintDatabaseSchema(first));
  });

  it("does not collapse Unicode spacing that SQLite treats as an identifier character", () => {
    const db = openMemoryDatabase(openDatabases);
    const deceptiveSchema = SCHEMA_SQL.replace("title TEXT NOT NULL", "title\u00a0TEXT NOT NULL");
    db.exec(deceptiveSchema);

    expect(normalizeSchemaSql("title\u00a0TEXT")).not.toBe(normalizeSchemaSql("title TEXT"));
    expect(normalizeSchemaSql("title\u000bTEXT")).not.toBe(normalizeSchemaSql("title TEXT"));
    expect(normalizeSchemaSql("\u00a0CREATE")).not.toBe(normalizeSchemaSql("CREATE"));
    expect(normalizeSchemaSql("CREATE\u00a0")).not.toBe(normalizeSchemaSql("CREATE"));
    expect(fingerprintDatabaseSchema(db)).not.toBe(KNOWN_DATABASE_SCHEMA_FINGERPRINTS.currentV1);
    expect(captureInspectionError(() => inspectDatabaseForMigration(db))).toMatchObject({
      code: "DB_MIGRATION_SCHEMA_UNKNOWN",
    });
  });

  it("does not confuse LIKE wildcard names with SQLite internal objects", () => {
    const db = openMemoryDatabase(openDatabases);
    db.exec(SCHEMA_SQL);
    db.exec("CREATE TABLE sqliteX (value TEXT)");

    expect(fingerprintDatabaseSchema(db)).not.toBe(KNOWN_DATABASE_SCHEMA_FINGERPRINTS.currentV1);
    expect(captureInspectionError(() => inspectDatabaseForMigration(db))).toMatchObject({
      code: "DB_MIGRATION_SCHEMA_UNKNOWN",
    });
  });
});

type HistoricalShape = "legacy-core-v1" | "legacy-agent-v1" | "current-v1";

function applyHistoricalShape(db: Database.Database, shape: HistoricalShape): void {
  db.exec(SCHEMA_SQL);
  if (shape === "current-v1") return;
  db.exec("DROP INDEX idx_agent_sessions_created; DROP TABLE agent_sessions;");
  if (shape === "legacy-agent-v1") return;
  db.exec(`
    DROP INDEX idx_agent_events_session_seq;
    DROP TABLE agent_events;
    DROP TABLE credentials;
    DROP TABLE provider_profiles;
  `);
}

function openMemoryDatabase(collection: Database.Database[]): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  collection.push(db);
  return db;
}

function captureInspectionError(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

function fakeInspectionPort(
  input: {
    readonly foreignKeys?: readonly unknown[];
    readonly inTransaction?: boolean;
    readonly integrity?: readonly unknown[];
    readonly open?: boolean;
    readonly prepareError?: unknown;
  } = {},
): DatabaseInspectionPort & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    open: input.open ?? true,
    inTransaction: input.inTransaction ?? false,
    calls,
    pragma(source: string): unknown {
      calls.push(`pragma:${source}`);
      if (source === "integrity_check") {
        return input.integrity ?? [{ integrity_check: "ok" }];
      }
      if (source === "foreign_key_check") return input.foreignKeys ?? [];
      throw new Error("unexpected pragma");
    },
    prepare(): never {
      calls.push("prepare");
      throw input.prepareError ?? new Error("prepare unavailable");
    },
  };
}
