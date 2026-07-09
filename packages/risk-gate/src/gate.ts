// RiskGate 引擎(M1 #28 / open-trad/opentrad#28)。
//
// 03-architecture.md §4.5 4 步判断:
//   1. blocked → 直接 deny + audit(automated)
//   2. safe + 无 businessAction → 直接 allow + audit(automated)
//   3. matching rule → 用规则 decision + audit(automated, reason='rule_matched')
//   4. promptUser → 用户决策 + audit(not automated)
//      4a. allow_always 时调 RuleProvider.save 写规则
//      4b. timeout / dismiss 走 UserPrompter 内部实现的 5min 超时(A6 补丁)
//
// 业务级 vs 工具级:由 computeBusinessAction 决定:
// - businessAction 显式提供 → 用之
// - stopBeforeList 包含 toolName → 用 toolName 当 businessAction 名(M1 简化)
// - 否则 null(纯工具级)
//
// 本类不感知 SQLite / IPC,通过 RuleProvider / AuditLogger / UserPrompter 注入。

import type {
  AuditEntry,
  AuditLogger,
  CheckResult,
  DecisionKind,
  RiskGateCheckRequest,
  RuleProvider,
  UserPrompter,
} from "./types";

export class RiskGate {
  constructor(
    private readonly rules: RuleProvider,
    private readonly audit: AuditLogger,
    private readonly prompter: UserPrompter,
  ) {}

  async check(req: RiskGateCheckRequest): Promise<CheckResult> {
    const businessAction = this.computeBusinessAction(req);
    const baseEntry = (
      decision: DecisionKind,
      automated: boolean,
      reason: string | null = null,
    ): AuditEntry => ({
      timestamp: Date.now(),
      sessionId: req.sessionId,
      skillId: req.skillId,
      toolName: req.toolName,
      businessAction,
      paramsJson: this.serializeParams(req.params),
      decision,
      automated,
      reason,
    });

    // 1. blocked 直接 deny
    if (req.riskLevel === "blocked") {
      await this.audit.append(baseEntry("deny", true, "blocked_policy"));
      return { decision: "deny", reason: "blocked_policy", automated: true };
    }

    // 2. safe + 无 businessAction → 直接 allow
    if (req.riskLevel === "safe" && !businessAction) {
      await this.audit.append(baseEntry("allow", true));
      return { decision: "allow", automated: true };
    }

    // 3. matching rule(优先级:业务级 / 工具级都走 risk_rules 表查;
    //    业务级查 (skillId, null, businessAction);工具级查 (skillId, toolName, null))
    const rule = await this.rules.findMatching({
      skillId: req.skillId,
      toolName: req.toolName,
      businessAction,
    });
    if (rule) {
      const decision: DecisionKind = rule.decision === "allow" ? "allow_always" : "deny";
      await this.audit.append(baseEntry(decision, true, "rule_matched"));
      return { decision, reason: "rule_matched", automated: true };
    }

    // 4. promptUser(包含 5min 超时,由 UserPrompter 内部实现)
    const userDecision = await this.prompter.request({
      sessionId: req.sessionId,
      skillId: req.skillId,
      toolName: req.toolName,
      riskLevel: req.riskLevel,
      params: req.params,
      businessAction,
      category: req.category ?? null,
    });

    let mappedDecision: DecisionKind;
    let auditReason: string | null = userDecision.reason ?? null;

    switch (userDecision.kind) {
      case "allow_once":
        mappedDecision = "allow_once";
        break;
      case "allow_always":
        mappedDecision = "allow_always";
        // 写规则(allow_always 触发);失败不阻塞 decision 返回(audit 仍记录)
        await this.rules.save({
          skillId: req.skillId,
          toolName: req.toolName,
          businessAction,
          decision: "allow",
        });
        break;
      case "deny":
        mappedDecision = "deny";
        break;
      case "request_edit":
        // D-M1-6 v1 简单实现:返回 deny + audit reason='user_requested_edit'
        mappedDecision = "deny";
        auditReason = auditReason ?? "user_requested_edit";
        break;
    }

    await this.audit.append(baseEntry(mappedDecision, false, auditReason));
    return {
      decision: mappedDecision,
      reason: auditReason ?? undefined,
      automated: false,
      userKind: userDecision.kind,
    };
  }

  // 业务级触发判断:displayBusinessAction 优先,否则 stopBeforeList 命中 toolName 升级
  private computeBusinessAction(req: RiskGateCheckRequest): string | null {
    if (req.businessAction && req.businessAction.length > 0) return req.businessAction;
    if (req.stopBeforeList?.includes(req.toolName)) {
      // M1 简化:用 toolName 当 businessAction 名;M2 视需求扩 tool→business mapping
      return req.toolName;
    }
    return null;
  }

  private serializeParams(params: unknown): string | null {
    try {
      return JSON.stringify(params);
    } catch {
      return null;
    }
  }
}
