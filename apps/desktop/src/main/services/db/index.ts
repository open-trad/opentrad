// DB 服务集合：把各 service 装在一个 DbServices bundle 里，单例方便注入。
// M0 spike（重启方向）新增：providerProfiles / agentEvents（credentials 表由
// services/credential-store.ts 直接持 db 操作——它还依赖 Electron safeStorage，不放本层）。

import type Database from "better-sqlite3";
import { AgentEventService } from "./agent-events";
import { AgentSessionService } from "./agent-sessions";
import { AuditLogService } from "./audit-log";
import { EventService } from "./events";
import { type OpenDbOptions, openDatabase } from "./init";
import { InstalledSkillService } from "./installed-skills";
import { ProviderProfileService } from "./provider-profiles";
import { RiskRuleService } from "./risk-rules";
import { SessionService } from "./sessions";
import { SettingsService } from "./settings";

export interface DbServices {
  db: Database.Database;
  sessions: SessionService;
  settings: SettingsService;
  installedSkills: InstalledSkillService;
  events: EventService;
  riskRules: RiskRuleService;
  auditLog: AuditLogService;
  providerProfiles: ProviderProfileService;
  agentEvents: AgentEventService;
  agentSessions: AgentSessionService;
  close: () => void;
}

export function createDbServices(opts: OpenDbOptions = {}): DbServices {
  const db = openDatabase(opts);
  return {
    db,
    sessions: new SessionService(db),
    settings: new SettingsService(db),
    installedSkills: new InstalledSkillService(db),
    events: new EventService(db),
    riskRules: new RiskRuleService(db),
    auditLog: new AuditLogService(db),
    providerProfiles: new ProviderProfileService(db),
    agentEvents: new AgentEventService(db),
    agentSessions: new AgentSessionService(db),
    close: () => {
      // foreign_keys 在 close 时自动 release；DELETE journal mode 不留 -wal/-shm
      db.close();
    },
  };
}

export {
  type AgentEventAppendInput,
  type AgentEventRow,
  AgentEventService,
} from "./agent-events";
export { type AgentSessionRow, AgentSessionService } from "./agent-sessions";
export { AuditLogService } from "./audit-log";
export { EventService } from "./events";
export { type OpenDbOptions, openDatabase } from "./init";
export { InstalledSkillService } from "./installed-skills";
export { getDbPath, getDraftsDir, getIpcSocketPath, getLockPath, getUserDataDir } from "./paths";
export { ProviderProfileService } from "./provider-profiles";
export { RiskRuleService } from "./risk-rules";
export { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";
export { SessionService } from "./sessions";
export { SettingsService } from "./settings";
