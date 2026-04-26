// Risk Gate domain IPC channels(M1 #30 Part C TD-002 拆分)。
//
// confirm / response:M1 #28 阶段 3 弹窗双向(main → renderer / renderer → main)。
// rules / audit:M1 #28 阶段 4 settings/risk 子页规则管理 + 审计日志查询。

export const RiskGateChannels = {
  RiskGateConfirm: "risk-gate:confirm",
  RiskGateResponse: "risk-gate:response",
  RiskRulesList: "risk-rules:list",
  RiskRulesDelete: "risk-rules:delete",
  AuditLogQuery: "audit-log:query",
} as const;
