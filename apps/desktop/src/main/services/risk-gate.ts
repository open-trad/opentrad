// RiskGate desktop main 接通(M1 #28 阶段 2)。
//
// 三个 adapter 把 packages/risk-gate 的 interface 接到具体能力:
// - DbRuleProvider:RuleProvider → db.riskRules(M1 #19 SQLite)
// - DbAuditLogger:AuditLogger → db.auditLog(M1 #19 SQLite)
// - IpcRiskGatePrompter:UserPrompter → IPC channel risk-gate:confirm 推 renderer +
//   5 分钟超时(发起人 explicit:在 main 进程 UserPrompter 实现,既是 user-facing
//   也是 bridge 兜底)+ graceful degrade(D-M1-5 deny by default):
//   - 无窗口 → deny + reason='no_renderer'
//   - 窗口已 destroyed → deny + reason='renderer_destroyed'
//   - 5min 超时 → deny + reason='timeout'

import { randomUUID } from "node:crypto";
import {
  type AuditEntry,
  type AuditLogger,
  type PromptRequest,
  RiskGate,
  type RuleProvider,
  type UserDecision,
  type UserDecisionKind,
  type UserPrompter,
} from "@opentrad/risk-gate";
import { IpcChannels, type RiskGateConfirmPayload } from "@opentrad/shared";
import type { BrowserWindow } from "electron";
import type { DbServices } from "./db";

// 5 分钟超时(A6 补丁)。在 main 进程 UserPrompter 实现,既是 user-facing 超时
// 也是 IPC bridge 端兜底(避免 mcp-server 端无限等导致 CC hang)。
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

// ----- DbRuleProvider -----

class DbRuleProvider implements RuleProvider {
  constructor(private readonly db: DbServices) {}

  async findMatching(query: {
    skillId: string | null;
    toolName: string;
    businessAction: string | null;
  }): Promise<{ decision: "allow" | "deny" } | null> {
    // 业务级查 (skillId, null, businessAction);工具级查 (skillId, toolName, null)
    const lookupKey = query.businessAction
      ? { skillId: query.skillId, toolName: null, businessAction: query.businessAction }
      : { skillId: query.skillId, toolName: query.toolName, businessAction: null };
    const rule = this.db.riskRules.findMatching(lookupKey);
    if (!rule) return null;
    return { decision: rule.decision };
  }

  async save(input: {
    skillId: string | null;
    toolName: string;
    businessAction: string | null;
    decision: "allow" | "deny";
  }): Promise<void> {
    // 同 findMatching:业务级写 toolName=null,工具级写 businessAction=null
    const saveKey = input.businessAction
      ? {
          skillId: input.skillId,
          toolName: null,
          businessAction: input.businessAction,
          decision: input.decision,
        }
      : {
          skillId: input.skillId,
          toolName: input.toolName,
          businessAction: null,
          decision: input.decision,
        };
    this.db.riskRules.save(saveKey);
  }
}

// ----- DbAuditLogger -----

class DbAuditLogger implements AuditLogger {
  constructor(private readonly db: DbServices) {}

  async append(entry: AuditEntry): Promise<void> {
    this.db.auditLog.append({
      timestamp: entry.timestamp,
      sessionId: entry.sessionId,
      skillId: entry.skillId,
      toolName: entry.toolName,
      businessAction: entry.businessAction,
      paramsJson: entry.paramsJson,
      decision: entry.decision,
      automated: entry.automated,
      reason: entry.reason,
    });
  }
}

// ----- IpcRiskGatePrompter -----

interface PendingPrompt {
  resolve: (decision: UserDecision) => void;
  timer: NodeJS.Timeout;
}

export class IpcRiskGatePrompter implements UserPrompter {
  private readonly pending = new Map<string, PendingPrompt>();

  constructor(private readonly getMainWindow: () => BrowserWindow | null) {}

  async request(req: PromptRequest): Promise<UserDecision> {
    const requestId = randomUUID();
    const win = this.getMainWindow();

    // graceful degrade #1:无窗口(主窗口未创建 / 已关闭)→ deny by default
    if (!win || win.isDestroyed()) {
      return { kind: "deny", reason: "no_renderer" };
    }

    return new Promise<UserDecision>((resolve) => {
      // 5min 超时(A6):timeout 后 audit_log 记 reason='timeout',mcp-server 端
      // cleanly 拿到 deny 不让 CC hang
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          resolve({ kind: "deny", reason: "timeout" });
        }
      }, PROMPT_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, timer });

      const payload: RiskGateConfirmPayload = {
        requestId,
        sessionId: req.sessionId,
        skillId: req.skillId,
        toolName: req.toolName,
        riskLevel: req.riskLevel,
        params: req.params,
        businessAction: req.businessAction,
        category: req.category,
      };
      try {
        win.webContents.send(IpcChannels.RiskGateConfirm, payload);
      } catch (err) {
        // graceful degrade #2:发送 IPC 异常 → 清 timer + deny
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ kind: "deny", reason: "ipc_send_error" });
        console.error("[risk-gate] webContents.send failed", err);
      }
    });
  }

  // 由 risk-gate:response IPC handler 调
  resolveDecision(requestId: string, kind: UserDecisionKind, reason?: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return; // 已 timeout / 已 destroyed
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(reason !== undefined ? { kind, reason } : { kind });
  }

  // 主窗口关闭时清所有 pending(回 deny + reason='renderer_destroyed')
  cleanupAll(): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ kind: "deny", reason: "renderer_destroyed" });
      this.pending.delete(id);
    }
  }
}

// ----- factory -----

export interface RiskGateBundle {
  gate: RiskGate;
  prompter: IpcRiskGatePrompter;
  // skillResolver 给 ipc-bridge-handlers 用(从 sessionId 查 skill 上下文,
  // 补 RiskGate.check 需要的 stopBeforeList / category)
  resolveSkillContext(sessionId: string): SkillContext;
}

export interface SkillContext {
  skillId: string | null;
  stopBeforeList: string[];
}

export function createRiskGate(
  db: DbServices,
  getMainWindow: () => BrowserWindow | null,
  resolveSkillContext: (sessionId: string) => SkillContext,
): RiskGateBundle {
  const prompter = new IpcRiskGatePrompter(getMainWindow);
  const gate = new RiskGate(new DbRuleProvider(db), new DbAuditLogger(db), prompter);
  return { gate, prompter, resolveSkillContext };
}
