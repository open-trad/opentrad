// SQLite schema 定义（按 03-architecture.md §五）。
// 6 张表：sessions / events / risk_rules / audit_log / settings / installed_skills。
// 字段命名遵循 SQL 惯例 snake_case；domain 层的 camelCase 映射在 service 层做。
//
// CHECK 约束：
//   sessions.status ∈ ('active','completed','cancelled','error')
//   risk_rules.decision ∈ ('allow','deny')
//   installed_skills.source ∈ ('builtin','user_import','marketplace')
//
// 索引：
//   idx_sessions_updated         (sessions.updated_at DESC) — list 分页
//   idx_sessions_skill           (sessions.skill_id)        — 按 skill 过滤
//   idx_events_session_seq       (events.session_id, seq)   — 事件回放
//   idx_risk_rules_key UNIQUE    (COALESCE 三键)            — 唯一规则匹配（D-M1 §三 (3)）
//   idx_audit_session            (audit_log.session_id)
//   idx_audit_timestamp          (audit_log.timestamp DESC) — /settings/risk 审计页
//
// 外键：events.session_id → sessions.id ON DELETE CASCADE。

// M0 spike（重启方向）追加 3 张新表：provider_profiles / credentials / agent_events。
// 均为纯新增（CREATE TABLE IF NOT EXISTS 幂等），不改旧表结构，故 SCHEMA_VERSION 不 bump
// （版本号语义留给"改动既有表"的迁移，见 init.ts 注释；M1 正式迁移机制时再收编）。
export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    skill_id TEXT,
    cc_session_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_model TEXT,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled', 'error'))
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_skill ON sessions(skill_id);

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq);

  CREATE TABLE IF NOT EXISTS risk_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT,
    tool_name TEXT,
    business_action TEXT,
    decision TEXT NOT NULL CHECK(decision IN ('allow', 'deny')),
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_rules_key ON risk_rules(
    COALESCE(skill_id, ''),
    COALESCE(tool_name, ''),
    COALESCE(business_action, '')
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    skill_id TEXT,
    tool_name TEXT NOT NULL,
    business_action TEXT,
    params_json TEXT,
    decision TEXT NOT NULL,
    automated INTEGER NOT NULL,
    reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS installed_skills (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK(source IN ('builtin', 'user_import', 'marketplace')),
    version TEXT NOT NULL,
    install_path TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    installed_at INTEGER NOT NULL
  );

  -- ProviderProfile（模型 provider 配置）：JSON 列整体存 profile
  --（形态由 @opentrad/model-providers 的 ProviderProfileSchema 定义，读出时 zod 校验）
  CREATE TABLE IF NOT EXISTS provider_profiles (
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- 凭证密文（Electron safeStorage 加密后的 BLOB）；SQLite 只存密文，绝无明文
  CREATE TABLE IF NOT EXISTS credentials (
    ref TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- AgentEvent 持久化（自建 loop 的事件流回放）；与旧 events 表（CCEvent）分开，不改旧表。
  -- 无 sessions 外键：agent 会话 M0 不写 sessions 表（utilityProcess/checkpoint 接线在 M1）。
  CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_events_session_seq ON agent_events(session_id, seq);
`;
