import type { AgentSessionStatus } from "@opentrad/shared";
import type Database from "better-sqlite3";

export interface AgentRuntimeBindingRow {
  sessionId: string;
  durableSessionId: string | null;
  profileId: string;
  workspaceRoot: string;
  status: AgentSessionStatus;
  resumable: boolean;
  generation: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRuntimeBindingCreateInput {
  sessionId: string;
  profileId: string;
  workspaceRoot: string;
  status: AgentSessionStatus;
  createdAt: number;
}

export interface AgentRuntimeBindingAttachInput {
  sessionId: string;
  durableSessionId: string;
  status: AgentSessionStatus;
  resumable: boolean;
  updatedAt: number;
}

export interface AgentRuntimeBindingStatusInput {
  sessionId: string;
  status: AgentSessionStatus;
  resumable: boolean;
  expectedGeneration: number;
  updatedAt: number;
}

interface AgentRuntimeBindingRawRow {
  session_id: string;
  durable_session_id: string | null;
  profile_id: string;
  workspace_root: string;
  status: AgentSessionStatus;
  resumable: number;
  generation: number;
  created_at: number;
  updated_at: number;
}

export class AgentRuntimeBindingService {
  private readonly stmtCreate;
  private readonly stmtGet;
  private readonly stmtAttach;
  private readonly stmtUpdateStatus;
  private readonly stmtListResumable;
  private readonly stmtInvalidateProfile;
  private readonly stmtDelete;

  constructor(db: Database.Database) {
    this.stmtCreate = db.prepare(
      `INSERT INTO agent_runtime_bindings (
        session_id, durable_session_id, profile_id, workspace_root,
        status, resumable, created_at, updated_at
      ) VALUES (?, NULL, ?, ?, ?, 0, ?, ?)`,
    );
    this.stmtGet = db.prepare<[string]>(
      "SELECT * FROM agent_runtime_bindings WHERE session_id = ?",
    );
    this.stmtAttach = db.prepare(
      `UPDATE agent_runtime_bindings
       SET durable_session_id = ?, status = ?, resumable = ?,
           generation = generation + 1, updated_at = ?
       WHERE session_id = ? AND durable_session_id IS NULL`,
    );
    this.stmtUpdateStatus = db.prepare(
      `UPDATE agent_runtime_bindings
       SET status = ?, resumable = ?, generation = generation + 1, updated_at = ?
       WHERE session_id = ? AND generation = ?
         AND (? = 0 OR durable_session_id IS NOT NULL)`,
    );
    this.stmtListResumable = db.prepare(
      `SELECT * FROM agent_runtime_bindings
       WHERE resumable = 1 AND durable_session_id IS NOT NULL
       ORDER BY updated_at DESC`,
    );
    this.stmtInvalidateProfile = db.prepare(
      `UPDATE agent_runtime_bindings
       SET status = 'read_only', resumable = 0,
           generation = generation + 1, updated_at = ?
       WHERE profile_id = ? AND (status != 'read_only' OR resumable != 0)`,
    );
    this.stmtDelete = db.prepare<[string]>(
      "DELETE FROM agent_runtime_bindings WHERE session_id = ?",
    );
  }

  create(input: AgentRuntimeBindingCreateInput): void {
    this.stmtCreate.run(
      input.sessionId,
      input.profileId,
      input.workspaceRoot,
      input.status,
      input.createdAt,
      input.createdAt,
    );
  }

  get(sessionId: string): AgentRuntimeBindingRow | undefined {
    const raw = this.stmtGet.get(sessionId) as AgentRuntimeBindingRawRow | undefined;
    return raw ? mapRow(raw) : undefined;
  }

  attachDurableSession(input: AgentRuntimeBindingAttachInput): boolean {
    const attached = this.stmtAttach.run(
      input.durableSessionId,
      input.status,
      input.resumable ? 1 : 0,
      input.updatedAt,
      input.sessionId,
    ).changes;
    if (attached === 1) return true;

    // A retry after an ambiguous boundary is successful only when the same
    // identity won the first attach. Never let a retry replace or rewind state.
    return this.get(input.sessionId)?.durableSessionId === input.durableSessionId;
  }

  updateStatus(input: AgentRuntimeBindingStatusInput): boolean {
    return (
      this.stmtUpdateStatus.run(
        input.status,
        input.resumable ? 1 : 0,
        input.updatedAt,
        input.sessionId,
        input.expectedGeneration,
        input.resumable ? 1 : 0,
      ).changes === 1
    );
  }

  listResumable(): AgentRuntimeBindingRow[] {
    return (this.stmtListResumable.all() as AgentRuntimeBindingRawRow[]).map(mapRow);
  }

  invalidateProfile(profileId: string, updatedAt: number): number {
    return this.stmtInvalidateProfile.run(updatedAt, profileId).changes;
  }

  delete(sessionId: string): boolean {
    return this.stmtDelete.run(sessionId).changes === 1;
  }
}

function mapRow(raw: AgentRuntimeBindingRawRow): AgentRuntimeBindingRow {
  return {
    sessionId: raw.session_id,
    durableSessionId: raw.durable_session_id,
    profileId: raw.profile_id,
    workspaceRoot: raw.workspace_root,
    status: raw.status,
    resumable: raw.resumable === 1,
    generation: raw.generation,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}
