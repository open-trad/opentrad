// RiskGate 引擎测试:4 步逻辑全覆盖 + 业务级判断 + 超时 + audit_log 落地。
//
// 用 fake RuleProvider / AuditLogger / UserPrompter 注入(本包纯逻辑,无外部依赖)。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RiskGate } from "../src/gate";
import type {
  AuditEntry,
  AuditLogger,
  PromptRequest,
  RiskGateCheckRequest,
  RuleProvider,
  UserDecision,
  UserPrompter,
} from "../src/types";

// ----- fake 实现 -----

function makeFakeRules(opts: {
  matching?: { decision: "allow" | "deny" } | null;
}): RuleProvider & { saveCalls: Array<Parameters<RuleProvider["save"]>[0]> } {
  const saveCalls: Array<Parameters<RuleProvider["save"]>[0]> = [];
  return {
    saveCalls,
    findMatching: vi.fn().mockResolvedValue(opts.matching ?? null),
    save: vi.fn().mockImplementation(async (input) => {
      saveCalls.push(input);
    }),
  };
}

function makeFakeAudit(): AuditLogger & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    append: vi.fn().mockImplementation(async (e: AuditEntry) => {
      entries.push(e);
    }),
  };
}

function makeFakePrompter(decision: UserDecision): UserPrompter & {
  requestCalls: PromptRequest[];
} {
  const requestCalls: PromptRequest[] = [];
  return {
    requestCalls,
    request: vi.fn().mockImplementation(async (req: PromptRequest) => {
      requestCalls.push(req);
      return decision;
    }),
  };
}

const baseReq = (overrides?: Partial<RiskGateCheckRequest>): RiskGateCheckRequest => ({
  sessionId: "sess-1",
  skillId: "trade-email-writer",
  toolName: "browser_open",
  riskLevel: "review",
  params: { url: "https://example.com/" },
  ...overrides,
});

describe("RiskGate.check — 步骤 1:blocked", () => {
  it("blocked riskLevel 直接 deny + audit(automated, reason='blocked_policy')", async () => {
    const rules = makeFakeRules({});
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "deny" });
    const gate = new RiskGate(rules, audit, prompter);

    const result = await gate.check(baseReq({ riskLevel: "blocked" }));

    expect(result).toEqual({ decision: "deny", reason: "blocked_policy", automated: true });
    expect(rules.findMatching).not.toHaveBeenCalled();
    expect(prompter.request).not.toHaveBeenCalled();
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      decision: "deny",
      automated: true,
      reason: "blocked_policy",
    });
  });
});

describe("RiskGate.check — 步骤 2:safe + 无 businessAction", () => {
  it("safe + 无 businessAction → 直接 allow + audit(automated)", async () => {
    const rules = makeFakeRules({});
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "deny" });
    const gate = new RiskGate(rules, audit, prompter);

    const result = await gate.check(baseReq({ toolName: "echo", riskLevel: "safe" }));

    expect(result).toEqual({ decision: "allow", automated: true });
    expect(rules.findMatching).not.toHaveBeenCalled();
    expect(prompter.request).not.toHaveBeenCalled();
    expect(audit.entries[0]).toMatchObject({
      decision: "allow",
      automated: true,
      reason: null,
    });
  });

  it("safe + businessAction(显式)→ 不直接 allow,走 rule / prompt", async () => {
    const rules = makeFakeRules({}); // 无 rule
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "allow_once" });
    const gate = new RiskGate(rules, audit, prompter);

    const result = await gate.check(
      baseReq({ toolName: "draft_save", riskLevel: "safe", businessAction: "send_email" }),
    );

    expect(prompter.request).toHaveBeenCalledTimes(1);
    expect(result.decision).toBe("allow_once");
    expect(audit.entries[0]?.businessAction).toBe("send_email");
  });

  it("safe + stopBeforeList 命中 toolName → 升级为业务级,走 prompt", async () => {
    const rules = makeFakeRules({});
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "allow_once" });
    const gate = new RiskGate(rules, audit, prompter);

    await gate.check(
      baseReq({
        toolName: "send_email",
        riskLevel: "safe",
        stopBeforeList: ["send_email", "publish_listing"],
      }),
    );

    expect(prompter.request).toHaveBeenCalledTimes(1);
    // M1 简化:用 toolName 当 businessAction 名
    expect(prompter.request).toHaveBeenCalledWith(
      expect.objectContaining({ businessAction: "send_email" }),
    );
  });
});

describe("RiskGate.check — 步骤 3:matching rule", () => {
  it("rule allow → allow_always + audit(automated, reason='rule_matched')", async () => {
    const rules = makeFakeRules({ matching: { decision: "allow" } });
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "deny" });
    const gate = new RiskGate(rules, audit, prompter);

    const result = await gate.check(baseReq());

    expect(result).toEqual({
      decision: "allow_always",
      reason: "rule_matched",
      automated: true,
    });
    expect(prompter.request).not.toHaveBeenCalled();
    expect(audit.entries[0]).toMatchObject({
      decision: "allow_always",
      automated: true,
      reason: "rule_matched",
    });
  });

  it("rule deny → deny + audit(automated, reason='rule_matched')", async () => {
    const rules = makeFakeRules({ matching: { decision: "deny" } });
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "allow_once" });
    const gate = new RiskGate(rules, audit, prompter);

    const result = await gate.check(baseReq());

    expect(result.decision).toBe("deny");
    expect(result.automated).toBe(true);
    expect(prompter.request).not.toHaveBeenCalled();
  });
});

describe("RiskGate.check — 步骤 4:promptUser", () => {
  it("allow_once → allow_once + audit(automated=false),不写规则", async () => {
    const rules = makeFakeRules({});
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "allow_once" });
    const gate = new RiskGate(rules, audit, prompter);

    const result = await gate.check(baseReq());

    expect(result.decision).toBe("allow_once");
    expect(result.automated).toBe(false);
    expect(result.userKind).toBe("allow_once");
    expect(rules.saveCalls).toHaveLength(0);
    expect(audit.entries[0]?.automated).toBe(false);
  });

  it("allow_always → allow_always + 写规则 + audit(automated=false)", async () => {
    const rules = makeFakeRules({});
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "allow_always" });
    const gate = new RiskGate(rules, audit, prompter);

    await gate.check(baseReq());

    expect(rules.saveCalls).toHaveLength(1);
    expect(rules.saveCalls[0]).toEqual({
      skillId: "trade-email-writer",
      toolName: "browser_open",
      businessAction: null,
      decision: "allow",
    });
    expect(audit.entries[0]?.decision).toBe("allow_always");
    expect(audit.entries[0]?.automated).toBe(false);
  });

  it("deny(用户主动)→ deny + audit(automated=false, reason 取自 user)", async () => {
    const rules = makeFakeRules({});
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "deny" });
    const gate = new RiskGate(rules, audit, prompter);

    const result = await gate.check(baseReq());

    expect(result.decision).toBe("deny");
    expect(result.automated).toBe(false);
    expect(rules.saveCalls).toHaveLength(0);
  });

  it("request_edit → deny + reason='user_requested_edit'(D-M1-6 v1)", async () => {
    const rules = makeFakeRules({});
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "request_edit" });
    const gate = new RiskGate(rules, audit, prompter);

    const result = await gate.check(baseReq());

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("user_requested_edit");
    expect(result.userKind).toBe("request_edit");
    expect(audit.entries[0]?.reason).toBe("user_requested_edit");
  });

  it("timeout(UserPrompter 内部超时返 deny + reason='timeout')→ audit reason='timeout'", async () => {
    const rules = makeFakeRules({});
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "deny", reason: "timeout" });
    const gate = new RiskGate(rules, audit, prompter);

    const result = await gate.check(baseReq());

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("timeout");
    expect(audit.entries[0]?.reason).toBe("timeout");
    expect(audit.entries[0]?.automated).toBe(false);
  });
});

describe("RiskGate audit_log 形态", () => {
  it("paramsJson 序列化 + 业务字段透传", async () => {
    const rules = makeFakeRules({});
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "allow_once" });
    const gate = new RiskGate(rules, audit, prompter);

    const params = { url: "https://example.com/", note: "hi" };
    await gate.check(baseReq({ params, businessAction: "send_email" }));

    expect(audit.entries[0]).toMatchObject({
      sessionId: "sess-1",
      skillId: "trade-email-writer",
      toolName: "browser_open",
      businessAction: "send_email",
      paramsJson: JSON.stringify(params),
    });
  });

  it("循环引用 params 不抛,paramsJson=null", async () => {
    const rules = makeFakeRules({});
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "deny" });
    const gate = new RiskGate(rules, audit, prompter);

    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    await gate.check(baseReq({ params: cyclic }));
    expect(audit.entries[0]?.paramsJson).toBeNull();
  });
});

describe("RiskGate 业务级 vs 工具级优先级", () => {
  it("displayBusinessAction 显式提供时优先于 stopBeforeList", async () => {
    const rules = makeFakeRules({});
    const audit = makeFakeAudit();
    const prompter = makeFakePrompter({ kind: "allow_once" });
    const gate = new RiskGate(rules, audit, prompter);

    await gate.check(
      baseReq({
        toolName: "browser_open",
        businessAction: "rfq_send",
        stopBeforeList: ["browser_open"], // 也命中,但 displayBusinessAction 优先
      }),
    );

    expect(prompter.request).toHaveBeenCalledWith(
      expect.objectContaining({ businessAction: "rfq_send" }),
    );
  });
});

describe("RiskGate 超时仿真(配合 UserPrompter 的真实 5min 实现)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("UserPrompter 模拟 5min 后 resolve { kind:'deny', reason:'timeout' }", async () => {
    const rules = makeFakeRules({});
    const audit = makeFakeAudit();
    const TIMEOUT_MS = 5 * 60 * 1000;

    // 真实场景下 UserPrompter 内部 setTimeout(5min) → resolve timeout deny
    const prompter: UserPrompter = {
      async request() {
        return new Promise<UserDecision>((resolve) => {
          setTimeout(() => resolve({ kind: "deny", reason: "timeout" }), TIMEOUT_MS);
        });
      },
    };
    const gate = new RiskGate(rules, audit, prompter);

    const checkPromise = gate.check(baseReq());
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    const result = await checkPromise;

    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("timeout");
    expect(audit.entries[0]?.reason).toBe("timeout");
  });
});
