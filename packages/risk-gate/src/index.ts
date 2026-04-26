// @opentrad/risk-gate 入口(M1 #28)。
// 纯逻辑 RiskGate 引擎(无 IPC / SQLite / Electron 依赖),通过三个 interface 注入。

export { RiskGate } from "./gate";
export type {
  AuditEntry,
  AuditLogger,
  CheckResult,
  DecisionKind,
  PromptRequest,
  RiskGateCheckRequest,
  RiskLevel,
  RuleProvider,
  UserDecision,
  UserDecisionKind,
  UserPrompter,
} from "./types";
