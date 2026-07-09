// RiskGate 类型(M1 #28 / open-trad/opentrad#28)。
//
// 03-architecture.md §4.5 设计:RiskGate.check 4 步判断 → 决策 → audit。
//
// 本包**纯逻辑**(无 IPC / SQLite / Electron 依赖),通过 RuleProvider /
// AuditLogger / UserPrompter 三个 interface 注入实际能力。这样:
// - 单测可注入 fake 实现,完整覆盖 4 步逻辑 + 业务级 / 工具级 / 超时分支
// - desktop 主进程注入 SQLite 实现 + IPC channel 弹窗实现
// - mcp-server 端通过 IPC bridge 调 desktop RiskGate(不直接 instantiate 本类)

export type RiskLevel = "safe" | "review" | "blocked";

// tool 调用前 mcp-server middleware 提交的检查请求
export interface RiskGateCheckRequest {
  sessionId: string;
  // 触发 tool 的 skill;为 null 时表示无 skill 上下文(不会发生在 M1 #24 后,但留接口宽容)
  skillId: string | null;
  toolName: string;
  riskLevel: RiskLevel;
  // tool 调用参数(后端透传,UI 侧负责脱敏展示)
  params: unknown;
  // 业务级触发条件:skill manifest.stopBefore(包含 toolName 时升级为业务级)
  stopBeforeList?: string[];
  // 业务级动作描述(tool 可显式提供,如 "send_email";否则由 stopBeforeList 推断)
  businessAction?: string;
  // for UI 展示
  category?: string;
}

// 最终落到 audit_log + 返回给 mcp-server 的 decision
export type DecisionKind = "allow" | "allow_once" | "allow_always" | "deny";

export interface CheckResult {
  decision: DecisionKind;
  // 自动决策的来源("blocked_policy" / "rule_matched" / "timeout" / "user_requested_edit"...)
  reason?: string;
  // automated=true 表示无用户交互(blocked / safe 自动 / rule 命中)
  automated: boolean;
  // 用户原始决策类型(供上层判断是否需要"以后都允许"额外动作);仅 automated=false 时存在
  userKind?: UserDecisionKind;
}

// ----- 三个注入 interface -----

export interface RuleProvider {
  // 查匹配规则(skillId / toolName / businessAction 三元组)
  findMatching(query: {
    skillId: string | null;
    toolName: string;
    businessAction: string | null;
  }): Promise<{ decision: "allow" | "deny" } | null>;
  // 写规则("以后都允许"触发);decision 限制在 allow / deny(no allow_once 概念)
  save(input: {
    skillId: string | null;
    toolName: string;
    businessAction: string | null;
    decision: "allow" | "deny";
  }): Promise<void>;
}

export interface AuditLogger {
  append(entry: AuditEntry): Promise<void>;
}

export interface AuditEntry {
  timestamp: number;
  sessionId: string;
  skillId: string | null;
  toolName: string;
  businessAction: string | null;
  paramsJson: string | null;
  decision: DecisionKind;
  automated: boolean;
  reason: string | null;
}

// 用户提示 / 弹窗
export interface UserPrompter {
  // 必须实现 5min 超时(A6 补丁):超时返回 { kind: "deny", reason: "timeout" }
  request(req: PromptRequest): Promise<UserDecision>;
}

export interface PromptRequest {
  sessionId: string;
  skillId: string | null;
  toolName: string;
  riskLevel: RiskLevel;
  params: unknown;
  // 业务级:非空时 UI 应展示 BusinessActionCard;空时展示 RiskGateDialog 工具级
  businessAction: string | null;
  category: string | null;
}

export type UserDecisionKind = "allow_once" | "allow_always" | "deny" | "request_edit";

export interface UserDecision {
  kind: UserDecisionKind;
  // timeout / dismiss 由 UserPrompter 实现填(timeout="timeout", dismiss="user_dismissed");
  // 用户主动点拒绝时为 undefined
  reason?: string;
}
