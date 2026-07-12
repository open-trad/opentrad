import { createHash } from "node:crypto";

export interface DatabaseInspectionPort {
  readonly open: boolean;
  readonly inTransaction: boolean;
  pragma(source: string): unknown;
  prepare(source: string): { all(...params: readonly unknown[]): unknown };
}

export type KnownDatabaseSchemaKind = "empty" | "legacy-core-v1" | "legacy-agent-v1" | "current-v1";

export interface DatabaseMigrationInspection {
  readonly kind: KnownDatabaseSchemaKind;
  readonly fingerprint: string;
  readonly objectCount: number;
}

export const KNOWN_DATABASE_SCHEMA_FINGERPRINTS = Object.freeze({
  empty: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  legacyCoreV1: "387c36f630629969bee2a0b5399b79e1cf06c94e72bdadc21f5a25ec72e8ab70",
  legacyAgentV1: "f1c2943679a0eb245db9942cfa71054226e4c2ecd18c418449ed19ad88f9370a",
  currentV1: "93bc4fdce92d08c60923c3157226ba7565504f0a032e87dccc18d5aad9a0d061",
});

export type DatabaseMigrationInspectionErrorCode =
  | "DB_MIGRATION_INSPECTION_UNAVAILABLE"
  | "DB_MIGRATION_INTEGRITY_FAILED"
  | "DB_MIGRATION_FOREIGN_KEY_FAILED"
  | "DB_MIGRATION_SCHEMA_UNKNOWN";

const ERROR_MESSAGES: Readonly<Record<DatabaseMigrationInspectionErrorCode, string>> = {
  DB_MIGRATION_INSPECTION_UNAVAILABLE: "Database migration inspection is unavailable",
  DB_MIGRATION_INTEGRITY_FAILED: "Database integrity validation failed",
  DB_MIGRATION_FOREIGN_KEY_FAILED: "Database foreign-key validation failed",
  DB_MIGRATION_SCHEMA_UNKNOWN: "Database schema is not recognized for migration",
};

const SCHEMA_QUERY = `
  SELECT type, name, tbl_name AS tableName, sql
  FROM main.sqlite_schema
  WHERE lower(name) NOT GLOB 'sqlite_*' AND sql IS NOT NULL
`;

const INTERNAL_ERROR_CODES = new WeakMap<object, DatabaseMigrationInspectionErrorCode>();

const KIND_BY_FINGERPRINT = new Map<string, KnownDatabaseSchemaKind>([
  [KNOWN_DATABASE_SCHEMA_FINGERPRINTS.empty, "empty"],
  [KNOWN_DATABASE_SCHEMA_FINGERPRINTS.legacyCoreV1, "legacy-core-v1"],
  [KNOWN_DATABASE_SCHEMA_FINGERPRINTS.legacyAgentV1, "legacy-agent-v1"],
  [KNOWN_DATABASE_SCHEMA_FINGERPRINTS.currentV1, "current-v1"],
]);

export class DatabaseMigrationInspectionError extends Error {
  readonly code: DatabaseMigrationInspectionErrorCode;

  constructor(code: DatabaseMigrationInspectionErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "DatabaseMigrationInspectionError";
    this.code = code;
  }
}

type SchemaTuple = readonly [
  type: "index" | "table" | "trigger" | "view",
  name: string,
  tableName: string,
  sql: string,
];

interface PhysicalSchemaSnapshot {
  readonly fingerprint: string;
  readonly objectCount: number;
}

interface OwnedDatabaseInspectionPort {
  assertAvailable(): void;
  pragma(source: string): unknown;
  readSchema(): unknown;
}

export function fingerprintDatabaseSchema(db: DatabaseInspectionPort): string {
  try {
    return snapshotPhysicalSchema(snapshotInspectionPort(db)).fingerprint;
  } catch (error) {
    throw normalizeInspectionError(error, "DB_MIGRATION_INSPECTION_UNAVAILABLE");
  }
}

export function inspectDatabaseForMigration(
  db: DatabaseInspectionPort,
): DatabaseMigrationInspection {
  const port = snapshotInspectionPort(db);
  validateIntegrity(port);
  validateForeignKeys(port);

  let snapshot: PhysicalSchemaSnapshot;
  try {
    snapshot = snapshotPhysicalSchema(port);
  } catch (error) {
    throw normalizeInspectionError(error, "DB_MIGRATION_INSPECTION_UNAVAILABLE");
  }
  const kind = KIND_BY_FINGERPRINT.get(snapshot.fingerprint);
  if (!kind) throw inspectionError("DB_MIGRATION_SCHEMA_UNKNOWN");
  return Object.freeze({ kind, ...snapshot });
}

export function normalizeSchemaSql(sql: string): string {
  if (typeof sql !== "string") {
    throw inspectionError("DB_MIGRATION_INSPECTION_UNAVAILABLE");
  }
  let output = "";
  let pendingSpace = false;
  let quote: "'" | '"' | "`" | "[" | undefined;

  const flushSpace = (): void => {
    if (pendingSpace && output.length > 0) output += " ";
    pendingSpace = false;
  };

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index] as string;
    const next = sql[index + 1];

    if (quote) {
      output += character;
      const closing = quote === "[" ? "]" : quote;
      if (character === closing) {
        if (next === closing) {
          output += next;
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }

    if (character === "-" && next === "-") {
      pendingSpace = true;
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      pendingSpace = true;
      index += 2;
      while (index < sql.length) {
        if (sql[index] === "*" && sql[index + 1] === "/") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      flushSpace();
      quote = character;
      output += character;
      continue;
    }
    if (isSqliteWhitespace(character)) {
      pendingSpace = true;
      continue;
    }
    flushSpace();
    output += character;
  }

  if (output.endsWith(";")) output = output.slice(0, -1);
  return output;
}

function snapshotPhysicalSchema(db: OwnedDatabaseInspectionPort): PhysicalSchemaSnapshot {
  const rawRows = db.readSchema();
  if (!Array.isArray(rawRows)) throw new Error();
  const tuples = rawRows.map(snapshotSchemaTuple);
  tuples.sort(compareSchemaTuples);
  const fingerprint = createHash("sha256").update(JSON.stringify(tuples), "utf8").digest("hex");
  db.assertAvailable();
  return Object.freeze({ fingerprint, objectCount: tuples.length });
}

function snapshotSchemaTuple(value: unknown): SchemaTuple {
  if (!isObjectLike(value)) throw new Error();
  const type = Reflect.get(value, "type");
  const name = Reflect.get(value, "name");
  const tableName = Reflect.get(value, "tableName");
  const sql = Reflect.get(value, "sql");
  if (
    (type !== "index" && type !== "table" && type !== "trigger" && type !== "view") ||
    typeof name !== "string" ||
    typeof tableName !== "string" ||
    typeof sql !== "string"
  ) {
    throw new Error();
  }
  return Object.freeze([type, name, tableName, normalizeSchemaSql(sql)]);
}

function compareSchemaTuples(left: SchemaTuple, right: SchemaTuple): number {
  const leftKey = left.join("\0");
  const rightKey = right.join("\0");
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function validateIntegrity(db: OwnedDatabaseInspectionPort): void {
  let rows: unknown;
  try {
    rows = db.pragma("integrity_check");
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error();
    const row = rows[0];
    if (!isObjectLike(row) || Reflect.get(row, "integrity_check") !== "ok") throw new Error();
  } catch {
    throw inspectionError("DB_MIGRATION_INTEGRITY_FAILED");
  }
  db.assertAvailable();
}

function validateForeignKeys(db: OwnedDatabaseInspectionPort): void {
  try {
    const rows = db.pragma("foreign_key_check");
    if (!Array.isArray(rows) || rows.length !== 0) throw new Error();
  } catch {
    throw inspectionError("DB_MIGRATION_FOREIGN_KEY_FAILED");
  }
  db.assertAvailable();
}

function snapshotInspectionPort(value: unknown): OwnedDatabaseInspectionPort {
  try {
    if (!isObjectLike(value)) throw new Error();
    const receiver = value as object;
    const pragma = Reflect.get(receiver, "pragma");
    const prepare = Reflect.get(receiver, "prepare");
    if (typeof pragma !== "function" || typeof prepare !== "function") throw new Error();
    const port: OwnedDatabaseInspectionPort = Object.freeze({
      assertAvailable: () => assertReceiverAvailable(receiver),
      pragma: (source: string) => Reflect.apply(pragma, receiver, [source]),
      readSchema: () => {
        const statement = Reflect.apply(prepare, receiver, [SCHEMA_QUERY]);
        if (!isObjectLike(statement)) throw new Error();
        const all = Reflect.get(statement, "all");
        if (typeof all !== "function") throw new Error();
        return Reflect.apply(all, statement, []);
      },
    });
    port.assertAvailable();
    return port;
  } catch (error) {
    throw normalizeInspectionError(error, "DB_MIGRATION_INSPECTION_UNAVAILABLE");
  }
}

function assertReceiverAvailable(receiver: object): void {
  try {
    if (
      Reflect.get(receiver, "open") !== true ||
      Reflect.get(receiver, "inTransaction") !== false
    ) {
      throw new Error();
    }
  } catch {
    throw inspectionError("DB_MIGRATION_INSPECTION_UNAVAILABLE");
  }
}

function normalizeInspectionError(
  value: unknown,
  fallback: DatabaseMigrationInspectionErrorCode,
): DatabaseMigrationInspectionError {
  const code = isObjectLike(value) ? INTERNAL_ERROR_CODES.get(value) : undefined;
  return inspectionError(code ?? fallback);
}

function inspectionError(
  code: DatabaseMigrationInspectionErrorCode,
): DatabaseMigrationInspectionError {
  const error = new DatabaseMigrationInspectionError(code);
  INTERNAL_ERROR_CODES.set(error, code);
  return Object.freeze(error);
}

function isSqliteWhitespace(character: string): boolean {
  const codePoint = character.charCodeAt(0);
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0c ||
    codePoint === 0x0d ||
    codePoint === 0x20
  );
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
