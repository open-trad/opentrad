// DB 服务集合：把 6 个 service 装在一个 DbServices bundle 里，单例方便注入。

import type Database from "better-sqlite3";
import { AuditLogService } from "./audit-log";
import { EventService } from "./events";
import { type OpenDbOptions, openDatabase } from "./init";
import { InstalledSkillService } from "./installed-skills";
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
    close: () => {
      // foreign_keys 在 close 时自动 release；DELETE journal mode 不留 -wal/-shm
      db.close();
    },
  };
}

export { AuditLogService } from "./audit-log";
export { EventService } from "./events";
export { type OpenDbOptions, openDatabase } from "./init";
export { InstalledSkillService } from "./installed-skills";
export { getDbPath, getLockPath, getUserDataDir } from "./paths";
export { RiskRuleService } from "./risk-rules";
export { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";
export { SessionService } from "./sessions";
export { SettingsService } from "./settings";
