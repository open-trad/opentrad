// AgentService 单测（M0 spike）：
// 1) 审批钩子三级映射（safe 直放 / review 走弹窗 / blocked 拒绝 + deny 语义映射）——
//    用真实 RiskGate + fake RuleProvider/AuditLogger/UserPrompter 驱动
// 2) 事件转发与落库：AgentEvent 先写 agent_events（seq 递增）再推 sink
// 3) profile 持久化：saveProfile 落 provider_profiles，新实例启动回灌
// 全部依赖注入，不 import electron。

import type { AgentSessionConfig, AgentSessionHandle } from "@opentrad/agent-core";
import type { ChatBackend, CredentialStore } from "@opentrad/model-providers";
import { RiskGate, type UserDecision } from "@opentrad/risk-gate";
import type { AgentEvent } from "@opentrad/shared";
import type { McpMountHandle, ToolDescriptor } from "@opentrad/tool-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService, createRiskGateApprovalHook } from "../src/main/services/agent-service";
import { createDbServices, type DbServices } from "../src/main/services/db";

// ---------- 脚手架 ----------

function fakeCredentials(): CredentialStore {
  const map = new Map<string, string>();
  return {
    get: async (ref) => map.get(ref) ?? null,
    set: async (ref, secret) => {
      map.set(ref, secret);
    },
    delete: async (ref) => {
      map.delete(ref);
    },
  };
}

interface AuditRecord {
  decision: string;
  automated: boolean;
  reason: string | null;
  toolName: string;
}

function fakeGate(promptDecision: UserDecision = { kind: "allow_once" }) {
  const audits: AuditRecord[] = [];
  const promptCalls: string[] = [];
  const gate = new RiskGate(
    // RuleProvider：无规则命中
    { findMatching: async () => null, save: async () => {} },
    {
      append: async (entry) => {
        audits.push({
          decision: entry.decision,
          automated: entry.automated,
          reason: entry.reason,
          toolName: entry.toolName,
        });
      },
    },
    {
      request: async (req) => {
        promptCalls.push(req.toolName);
        return promptDecision;
      },
    },
  );
  return { gate, audits, promptCalls };
}

function descriptor(riskLevel: "safe" | "review" | "blocked", name = "t"): ToolDescriptor {
  return { name, description: name, inputSchema: { type: "object" }, source: "mcp", riskLevel };
}

// 可控的 fake AgentSession：暴露 emit 让测试驱动事件流
interface FakeSession {
  config: AgentSessionConfig;
  emit: (event: AgentEvent) => void;
  sendImpl: (message: string) => Promise<void>;
  abort: ReturnType<typeof vi.fn>;
}

function fakeSessionFactory() {
  const sessions: FakeSession[] = [];
  const create = (config: AgentSessionConfig): AgentSessionHandle => {
    const listeners = new Set<(event: AgentEvent) => void>();
    const fake: FakeSession = {
      config,
      emit: (event) => {
        for (const l of listeners) l(event);
      },
      sendImpl: async () => {},
      abort: vi.fn(),
    };
    sessions.push(fake);
    return {
      sessionId: config.sessionId,
      send: (message) => fake.sendImpl(message),
      abort: fake.abort,
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  };
  return { sessions, create };
}

function fakeBackend(): ChatBackend {
  return { profileId: "p1", kind: "openai-compatible", resolveModel: async () => ({}) };
}

const PROFILE = {
  id: "p1",
  displayName: "DeepSeek",
  kind: "openai-compatible",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  credentialRef: "apikey:p1",
  pricing: null,
};

// ---------- 审批钩子三级映射 ----------

describe("createRiskGateApprovalHook", () => {
  it("safe：直放 allow，不弹窗，audit 记 automated allow", async () => {
    const { gate, audits, promptCalls } = fakeGate();
    const hook = createRiskGateApprovalHook(gate, "s1");
    const verdict = await hook(descriptor("safe", "mcp:bb:read"), { q: 1 });
    expect(verdict.decision).toBe("allow");
    expect(promptCalls).toHaveLength(0);
    expect(audits).toEqual([
      { decision: "allow", automated: true, reason: null, toolName: "mcp:bb:read" },
    ]);
  });

  it("blocked：拒绝，不弹窗，reason=blocked_policy", async () => {
    const { gate, promptCalls } = fakeGate();
    const hook = createRiskGateApprovalHook(gate, "s1");
    const verdict = await hook(descriptor("blocked", "mcp:bb:pay"), {});
    expect(verdict).toEqual({ decision: "deny", reason: "blocked_policy" });
    expect(promptCalls).toHaveLength(0);
  });

  it("review：走弹窗；用户 allow_once → allow", async () => {
    const { gate, promptCalls } = fakeGate({ kind: "allow_once" });
    const hook = createRiskGateApprovalHook(gate, "s1");
    const verdict = await hook(descriptor("review", "mcp:bb:write"), {});
    expect(verdict.decision).toBe("allow");
    expect(promptCalls).toEqual(["mcp:bb:write"]);
  });

  it("review：用户 deny → deny 语义映射（reason 透传），audit 记非 automated", async () => {
    const { gate, audits, promptCalls } = fakeGate({ kind: "deny", reason: "user said no" });
    const hook = createRiskGateApprovalHook(gate, "s1");
    const verdict = await hook(descriptor("review", "mcp:bb:write"), {});
    expect(verdict).toEqual({ decision: "deny", reason: "user said no" });
    expect(promptCalls).toEqual(["mcp:bb:write"]);
    expect(audits.at(-1)).toEqual({
      decision: "deny",
      automated: false,
      reason: "user said no",
      toolName: "mcp:bb:write",
    });
  });

  it("review：弹窗超时 deny（UserPrompter 内部超时语义）也映射为 deny", async () => {
    const { gate } = fakeGate({ kind: "deny", reason: "timeout" });
    const hook = createRiskGateApprovalHook(gate, "s1");
    const verdict = await hook(descriptor("review"), {});
    expect(verdict).toEqual({ decision: "deny", reason: "timeout" });
  });

  it("safe + businessAction：升级为业务级，仍走弹窗（stopBefore 语义保留）", async () => {
    const { gate, promptCalls } = fakeGate({ kind: "allow_once" });
    const hook = createRiskGateApprovalHook(gate, "s1");
    const tool: ToolDescriptor = {
      ...descriptor("safe", "publish"),
      businessAction: "publish_listing",
    };
    const verdict = await hook(tool, {});
    expect(verdict.decision).toBe("allow");
    expect(promptCalls).toEqual(["publish"]);
  });
});

// ---------- AgentService 事件转发 / 落库 / profile 持久化 ----------

describe("AgentService", () => {
  let db: DbServices;

  beforeEach(() => {
    db = createDbServices({ dbPath: ":memory:" });
  });

  afterEach(() => {
    db.close();
  });

  function makeService(factory = fakeSessionFactory(), promptDecision?: UserDecision) {
    const { gate } = fakeGate(promptDecision);
    const service = new AgentService(
      {
        profiles: db.providerProfiles,
        agentEvents: db.agentEvents,
        credentials: fakeCredentials(),
        gate,
      },
      {
        createBackend: () => fakeBackend(),
        createSession: factory.create,
        mountMcp: async (_host, config) => makeMount(config.name),
      },
    );
    return { service, factory };
  }

  const closedMounts: string[] = [];
  function makeMount(name: string): McpMountHandle {
    return {
      serverName: name,
      toolNames: [],
      close: async () => {
        closedMounts.push(name);
      },
    };
  }

  it("saveProfile 持久化到 provider_profiles；新实例启动回灌 registry", () => {
    const { service } = makeService();
    service.saveProfile(PROFILE);
    expect(service.listProfiles().map((p) => p.id)).toEqual(["p1"]);

    // 新实例（同一 db）：回灌
    const { service: service2 } = makeService();
    expect(service2.listProfiles().map((p) => p.id)).toEqual(["p1"]);

    service2.deleteProfile("p1");
    const { service: service3 } = makeService();
    expect(service3.listProfiles()).toEqual([]);
  });

  it("saveProfile：非法 profile 拒绝且不落库", () => {
    const { service } = makeService();
    expect(() => service.saveProfile({ id: "bad" })).toThrow();
    expect(db.providerProfiles.listRaw()).toEqual([]);
  });

  it("startSession：未知 profile 拒绝", async () => {
    const { service } = makeService();
    await expect(service.startSession(baseReq(), { send: () => {} })).rejects.toThrow(
      /unknown provider profile/,
    );
  });

  it("事件转发与落库：先写 agent_events（seq 递增、payload 保真），再推 sink", async () => {
    const factory = fakeSessionFactory();
    const { service } = makeService(factory);
    service.saveProfile(PROFILE);

    const received: AgentEvent[] = [];
    const sessionId = await service.startSession(baseReq(), {
      send: (event) => received.push(event),
    });

    const fake = factory.sessions[0];
    expect(fake).toBeDefined();
    if (!fake) throw new Error("session not created");
    // 会话配置来自 profile
    expect(fake.config.model).toBe("deepseek-chat");
    expect(fake.config.sessionId).toBe(sessionId);

    const events: AgentEvent[] = [
      {
        type: "agent_session_start",
        sessionId,
        profileId: "p1",
        model: "deepseek-chat",
        tools: [],
      },
      { type: "agent_text", sessionId, msgId: "m1", delta: "你好", done: false },
      { type: "agent_text", sessionId, msgId: "m1", delta: "", done: true },
      {
        type: "agent_session_result",
        sessionId,
        subtype: "success",
        durationMs: 10,
        numSteps: 1,
        totalCostUsd: null,
      },
    ];
    for (const event of events) fake.emit(event);

    // sink 收到全部且有序
    expect(received.map((e) => e.type)).toEqual([
      "agent_session_start",
      "agent_text",
      "agent_text",
      "agent_session_result",
    ]);

    // 落库：seq 0..3、payload JSON 保真
    const rows = db.agentEvents.readBySession(sessionId);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(rows.map((r) => r.type)).toEqual(received.map((e) => e.type));
    expect(JSON.parse(rows[1]?.payload ?? "")).toEqual(events[1]);
  });

  it("send 状态错误（并发/已结束）→ 转 agent_error 事件推回并落库", async () => {
    const factory = fakeSessionFactory();
    const { service } = makeService(factory);
    service.saveProfile(PROFILE);

    const received: AgentEvent[] = [];
    const sessionId = await service.startSession(baseReq(), {
      send: (event) => received.push(event),
    });
    const fake = factory.sessions[0];
    if (!fake) throw new Error("session not created");
    fake.sendImpl = async () => {
      throw new Error("already processing a message");
    };

    service.send(sessionId, "hi");
    await vi.waitFor(() => {
      expect(received.some((e) => e.type === "agent_error")).toBe(true);
    });
    const rows = db.agentEvents.readBySession(sessionId);
    expect(rows.at(-1)?.type).toBe("agent_error");
  });

  it("终态 result（非 success）：卸载 MCP、移出会话 Map（再 send 报 unknown）", async () => {
    closedMounts.length = 0;
    const factory = fakeSessionFactory();
    const { service } = makeService(factory);
    service.saveProfile(PROFILE);

    const sessionId = await service.startSession(
      { ...baseReq(), mcpServers: [{ name: "bb", command: "npx", args: ["bb-browser-mcp"] }] },
      { send: () => {} },
    );
    const fake = factory.sessions[0];
    if (!fake) throw new Error("session not created");

    fake.emit({
      type: "agent_session_result",
      sessionId,
      subtype: "aborted",
      durationMs: 1,
      numSteps: 0,
      totalCostUsd: null,
    });
    await vi.waitFor(() => {
      expect(closedMounts).toEqual(["bb"]);
    });
    expect(() => service.send(sessionId, "hi")).toThrow(/unknown agent session/);
  });

  it("disposeAll：中止全部会话并卸载 MCP", async () => {
    closedMounts.length = 0;
    const factory = fakeSessionFactory();
    const { service } = makeService(factory);
    service.saveProfile(PROFILE);
    await service.startSession(
      { ...baseReq(), mcpServers: [{ name: "bb", command: "npx" }] },
      { send: () => {} },
    );

    await service.disposeAll();
    expect(factory.sessions[0]?.abort).toHaveBeenCalled();
    expect(closedMounts).toEqual(["bb"]);
  });
});

function baseReq() {
  return {
    profileId: "p1",
    maxSteps: 50,
    budgetUsd: null,
    mcpServers: [] as { name: string; command: string; args?: string[] }[],
  };
}
