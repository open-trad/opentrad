// AgentService 单测（M0 spike）：
// 1) 审批钩子三级映射（safe 直放 / review 走弹窗 / blocked 拒绝 + deny 语义映射）——
//    用真实 RiskGate + fake RuleProvider/AuditLogger/UserPrompter 驱动
// 2) 事件转发与落库：AgentEvent 先写 agent_events（seq 递增）再推 sink
// 3) profile 持久化：saveProfile 落 provider_profiles，新实例启动回灌
// 全部依赖注入，不 import electron。

import type { AgentSessionConfig, AgentSessionHandle } from "@opentrad/agent-core";
import type { ChatBackend, CredentialStore } from "@opentrad/model-providers";
import { type PromptRequest, RiskGate, type UserDecision } from "@opentrad/risk-gate";
import type {
  RuntimeAdapter,
  RuntimeBinding,
  RuntimeCreateInput,
  RuntimeEventSink,
  RuntimeResumeInput,
} from "@opentrad/runtime-adapter";
import type { AgentEvent } from "@opentrad/shared";
import type { McpMountHandle, ToolDescriptor } from "@opentrad/tool-host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentService,
  createRiskGateApprovalHook,
  mapRiskGateDecisionToHermesApproval,
} from "../src/main/services/agent-service";
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
  sessionId: string;
  decision: string;
  automated: boolean;
  reason: string | null;
  skillId: string | null;
  toolName: string;
  paramsJson: string | null;
}

function fakeGate(promptDecision: UserDecision | Promise<UserDecision> = { kind: "allow_once" }) {
  const audits: AuditRecord[] = [];
  const promptCalls: string[] = [];
  const promptRequests: PromptRequest[] = [];
  const savedRules: Array<{
    skillId: string | null;
    toolName: string;
    businessAction: string | null;
    decision: "allow" | "deny";
  }> = [];
  const gate = new RiskGate(
    // RuleProvider：无规则命中
    {
      findMatching: async () => null,
      save: async (input) => {
        savedRules.push(input);
      },
    },
    {
      append: async (entry) => {
        audits.push({
          sessionId: entry.sessionId,
          decision: entry.decision,
          automated: entry.automated,
          reason: entry.reason,
          skillId: entry.skillId,
          toolName: entry.toolName,
          paramsJson: entry.paramsJson,
        });
      },
    },
    {
      request: async (req) => {
        promptCalls.push(req.toolName);
        promptRequests.push(req);
        return promptDecision;
      },
    },
  );
  return { gate, audits, promptCalls, promptRequests, savedRules };
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function runtimeBinding(sessionId: string, suffix = "1"): RuntimeBinding {
  return {
    canonicalSessionId: sessionId,
    liveRuntimeSessionId: `live-${suffix}`,
    durableRuntimeSessionId: `durable-${suffix}`,
  };
}

function fakeHermesRuntime() {
  const calls: string[] = [];
  const createInputs: RuntimeCreateInput[] = [];
  const resumeInputs: RuntimeResumeInput[] = [];
  const streamInputs: { binding: RuntimeBinding; prompt: string }[] = [];
  const interruptInputs: RuntimeBinding[] = [];
  const closeInputs: RuntimeBinding[] = [];
  const invalidateProfileInputs: string[] = [];
  const approvalInputs: { binding: RuntimeBinding; choice: string }[] = [];
  const sudoInputs: { binding: RuntimeBinding; requestId: string; password: string }[] = [];
  const secretInputs: { binding: RuntimeBinding; requestId: string; value: string }[] = [];
  let createImpl = async (input: RuntimeCreateInput) =>
    runtimeBinding(input.canonicalSessionId, String(createInputs.length));
  let resumeImpl = async (input: RuntimeResumeInput) =>
    runtimeBinding(input.canonicalSessionId, `resume-${resumeInputs.length}`);
  let streamImpl = async (_binding: RuntimeBinding, _prompt: string, _emit: RuntimeEventSink) => {};
  let interruptImpl = async (_binding: RuntimeBinding) => {};
  let invalidateProfileImpl = async (_profileId: string) => {};

  const runtime: RuntimeAdapter = {
    kind: "hermes",
    ready: async () => ({ version: "hermes-agent/0.18.2" }),
    create: async (input) => {
      calls.push("create");
      createInputs.push(input);
      return createImpl(input);
    },
    resume: async (input) => {
      calls.push("resume");
      resumeInputs.push(input);
      return resumeImpl(input);
    },
    stream: async (binding, prompt, emit) => {
      calls.push("stream");
      streamInputs.push({ binding, prompt });
      return streamImpl(binding, prompt, emit);
    },
    interrupt: async (binding) => {
      calls.push("interrupt");
      interruptInputs.push(binding);
      return interruptImpl(binding);
    },
    respondApproval: async (binding, choice) => {
      calls.push("respondApproval");
      approvalInputs.push({ binding, choice });
    },
    respondSudo: async (binding, requestId, password) => {
      calls.push("respondSudo");
      sudoInputs.push({ binding, requestId, password });
    },
    respondSecret: async (binding, requestId, value) => {
      calls.push("respondSecret");
      secretInputs.push({ binding, requestId, value });
    },
    close: async (binding) => {
      calls.push("close");
      closeInputs.push(binding);
    },
    invalidateProfile: async (profileId) => {
      calls.push("invalidateProfile");
      invalidateProfileInputs.push(profileId);
      return invalidateProfileImpl(profileId);
    },
    onCrash: () => () => {},
    dispose: async () => {
      calls.push("dispose");
    },
  };

  return {
    runtime,
    calls,
    createInputs,
    resumeInputs,
    streamInputs,
    interruptInputs,
    closeInputs,
    invalidateProfileInputs,
    approvalInputs,
    sudoInputs,
    secretInputs,
    setCreateImpl(impl: typeof createImpl) {
      createImpl = impl;
    },
    setResumeImpl(impl: typeof resumeImpl) {
      resumeImpl = impl;
    },
    setStreamImpl(impl: typeof streamImpl) {
      streamImpl = impl;
    },
    setInterruptImpl(impl: typeof interruptImpl) {
      interruptImpl = impl;
    },
    setInvalidateProfileImpl(impl: typeof invalidateProfileImpl) {
      invalidateProfileImpl = impl;
    },
  };
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

const PROFILE_CREDENTIAL = {
  ref: "apikey:p1",
  secret: "test-api-key-value",
};

const OAUTH_PROFILE = {
  id: "oauth-profile",
  displayName: "ChatGPT",
  kind: "openai" as const,
  model: "gpt-5.4",
  pricing: null,
  hermes: {
    providerSlug: "openai-codex",
    authMode: "oauth" as const,
    apiMode: "codex_responses" as const,
    executionBackend: "local" as const,
  },
};

function fakeProfileHomeDeleter(
  stage: (
    profileId: string,
    transition: { oldAuthorityHash: string; newAuthorityHash: string | null },
  ) => Promise<{ finalize(): Promise<void>; rollback(): Promise<void> }>,
) {
  return Object.assign(vi.fn(stage), {
    recover: vi.fn(async () => ({ blockedProfileIds: [] as string[] })),
  });
}

// ---------- 审批钩子三级映射 ----------

describe("createRiskGateApprovalHook", () => {
  it("safe：直放 allow，不弹窗，audit 记 automated allow", async () => {
    const { gate, audits, promptCalls } = fakeGate();
    const hook = createRiskGateApprovalHook(gate, "s1");
    const verdict = await hook(descriptor("safe", "mcp:bb:read"), { q: 1 });
    expect(verdict.decision).toBe("allow");
    expect(promptCalls).toHaveLength(0);
    expect(audits).toEqual([
      {
        sessionId: "s1",
        decision: "allow",
        automated: true,
        reason: null,
        skillId: null,
        toolName: "mcp:bb:read",
        paramsJson: '{"q":1}',
      },
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
      sessionId: "s1",
      decision: "deny",
      automated: false,
      reason: "user said no",
      skillId: null,
      toolName: "mcp:bb:write",
      paramsJson: "{}",
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

describe("mapRiskGateDecisionToHermesApproval", () => {
  it.each([
    ["allow", "once"],
    ["allow_once", "once"],
    ["allow_session", "session"],
    ["allow_always", "always"],
    ["deny", "deny"],
  ] as const)("maps %s to %s", (decision, expected) => {
    expect(mapRiskGateDecisionToHermesApproval(decision)).toBe(expected);
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
        agentSessions: db.agentSessions,
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

  function makeNativeService(
    fakeRuntime = fakeHermesRuntime(),
    validateWorkspaceRoot = vi.fn(async (workspaceRoot: string) => workspaceRoot),
    hermesInteractionPrompter?: {
      requestApproval: ReturnType<typeof vi.fn>;
      requestSudo: ReturnType<typeof vi.fn>;
      requestSecret: ReturnType<typeof vi.fn>;
      handleResponse: ReturnType<typeof vi.fn>;
      cleanupAll: ReturnType<typeof vi.fn>;
    },
    validateExecutionBackend?: ReturnType<typeof vi.fn>,
    credentials: CredentialStore = fakeCredentials(),
    riskGateFixture = fakeGate(),
    deleteProfileHome = Object.assign(
      vi.fn(async (_profileId: string, _transition: unknown) => ({
        finalize: vi.fn(async () => {}),
        rollback: vi.fn(async () => {}),
      })),
      { recover: vi.fn(async () => ({ blockedProfileIds: [] })) },
    ),
    invalidateOAuthProfile?: (profileId: string) => Promise<void>,
  ) {
    const service = new AgentService({
      profiles: db.providerProfiles,
      agentEvents: db.agentEvents,
      agentSessions: db.agentSessions,
      agentRuntimeBindings: db.agentRuntimeBindings,
      credentials,
      gate: riskGateFixture.gate,
      runtime: fakeRuntime.runtime,
      validateWorkspaceRoot,
      validateExecutionBackend,
      hermesInteractionPrompter,
      deleteProfileHome,
      invalidateOAuthProfile,
    });
    return {
      service,
      fakeRuntime,
      validateWorkspaceRoot,
      deleteProfileHome,
      ...riskGateFixture,
    };
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

  it("saveProfile 持久化到 provider_profiles；新实例启动回灌 registry", async () => {
    const { service } = makeService();
    await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
    expect(service.listProfiles().map((p) => p.id)).toEqual(["p1"]);

    // 新实例（同一 db）：回灌
    const { service: service2 } = makeService();
    expect(service2.listProfiles().map((p) => p.id)).toEqual(["p1"]);

    await service2.deleteProfile("p1");
    const { service: service3 } = makeService();
    expect(service3.listProfiles()).toEqual([]);
  });

  it("saveProfile：非法 profile 拒绝且不落库", () => {
    const { service } = makeService();
    expect(() => service.saveProfile({ id: "bad" })).toThrow();
    expect(db.providerProfiles.listRaw()).toEqual([]);
  });

  it("marks dormant Hermes bindings read-only when a Profile is overwritten in legacy mode", async () => {
    const { gate } = fakeGate();
    const service = new AgentService({
      profiles: db.providerProfiles,
      agentEvents: db.agentEvents,
      agentSessions: db.agentSessions,
      agentRuntimeBindings: db.agentRuntimeBindings,
      credentials: fakeCredentials(),
      gate,
    });
    await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
    db.agentSessions.create("dormant-session", PROFILE.model, 1);
    db.agentRuntimeBindings.create({
      sessionId: "dormant-session",
      profileId: "p1",
      workspaceRoot: "/tmp/workspace",
      status: "creating",
      createdAt: 1,
    });
    db.agentRuntimeBindings.attachDurableSession({
      sessionId: "dormant-session",
      durableSessionId: "durable-1",
      status: "idle",
      resumable: true,
      updatedAt: 2,
    });

    await service.saveProfile({ ...PROFILE, displayName: "Legacy overwrite" });

    expect(db.agentRuntimeBindings.get("dormant-session")).toMatchObject({
      status: "read_only",
      resumable: false,
    });
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
    await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);

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

  it("会话历史：startSession 建 agent_sessions 行，send 持久化用户消息 + 设标题，可回放", async () => {
    const { service } = makeService();
    await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
    const sessionId = await service.startSession(baseReq(), { send: () => {} });

    // startSession 建了会话元数据（标题此时为空）
    let list = service.listSessions();
    expect(list.map((s) => s.sessionId)).toContain(sessionId);
    expect(list.find((s) => s.sessionId === sessionId)?.model).toBe("deepseek-chat");
    expect(service.isSessionResumable(sessionId)).toBe(false);

    // send 持久化用户消息并把首条设为标题
    service.send(sessionId, "帮我找 usb hub 的货源");
    list = service.listSessions();
    expect(list.find((s) => s.sessionId === sessionId)?.title).toBe("帮我找 usb hub 的货源");

    // 回放：事件流里含 agent_user 用户消息
    const events = service.loadSessionEvents(sessionId) as { type: string; text?: string }[];
    const userEvt = events.find((e) => e.type === "agent_user");
    expect(userEvt?.text).toBe("帮我找 usb hub 的货源");
  });

  it("send 状态错误（并发/已结束）→ 转 agent_error 事件推回并落库", async () => {
    const factory = fakeSessionFactory();
    const { service } = makeService(factory);
    await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);

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
    await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);

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
    await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
    await service.startSession(
      { ...baseReq(), mcpServers: [{ name: "bb", command: "npx" }] },
      { send: () => {} },
    );

    await service.disposeAll();
    expect(factory.sessions[0]?.abort).toHaveBeenCalled();
    expect(closedMounts).toEqual(["bb"]);
  });

  describe("native Hermes runtime", () => {
    it("revalidates and canonicalizes workspace, then persists the durable binding", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const validateWorkspaceRoot = vi.fn(async () => "/private/tmp/canonical-workspace");
      const { service } = makeNativeService(fakeRuntime, validateWorkspaceRoot);
      await service.saveProfile(PROFILE, { ref: "apikey:p1", secret: "old-test-value" });

      const sessionId = await service.startSession(baseReq(), { send: () => {} });

      expect(validateWorkspaceRoot).toHaveBeenCalledWith("/tmp/workspace");
      expect(fakeRuntime.createInputs).toHaveLength(1);
      expect(fakeRuntime.createInputs[0]).toMatchObject({
        canonicalSessionId: sessionId,
        taskId: sessionId,
        workspaceRoot: "/private/tmp/canonical-workspace",
        provider: {
          profileId: "p1",
          providerSlug: "deepseek",
          authMode: "api_key",
          apiMode: "chat_completions",
          executionBackend: "local",
          model: "deepseek-chat",
        },
      });
      expect(db.agentRuntimeBindings.get(sessionId)).toMatchObject({
        sessionId,
        durableSessionId: "durable-1",
        profileId: "p1",
        workspaceRoot: "/private/tmp/canonical-workspace",
        status: "idle",
        resumable: true,
        generation: 1,
      });
      expect(service.listSessions().find((row) => row.sessionId === sessionId)).toMatchObject({
        profileId: "p1",
        workspaceRoot: "/private/tmp/canonical-workspace",
        status: "idle",
        resumable: true,
      });
      expect(service.isSessionResumable(sessionId)).toBe(true);
    });

    it("fails closed when native workspace validation is unavailable", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const { gate } = fakeGate();
      const service = new AgentService({
        profiles: db.providerProfiles,
        agentEvents: db.agentEvents,
        agentSessions: db.agentSessions,
        agentRuntimeBindings: db.agentRuntimeBindings,
        credentials: fakeCredentials(),
        gate,
        runtime: fakeRuntime.runtime,
      });
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);

      await expect(service.startSession(baseReq(), { send: () => {} })).rejects.toThrow(
        "Hermes workspace validation is unavailable",
      );
      expect(fakeRuntime.createInputs).toEqual([]);
    });

    it("validates Docker availability before creating any session state", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const validateExecutionBackend = vi.fn(async () => {
        throw new Error("docker detail canary");
      });
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        validateExecutionBackend,
      );
      const dockerProfile = {
        ...PROFILE,
        hermes: {
          providerSlug: "deepseek",
          authMode: "api_key" as const,
          apiMode: "chat_completions" as const,
          executionBackend: "docker" as const,
        },
      };
      await service.saveProfile(dockerProfile, PROFILE_CREDENTIAL);

      const error = await service
        .startSession(baseReq(), { send: () => {} })
        .catch((cause) => cause);

      expect(validateExecutionBackend).toHaveBeenCalledWith(
        expect.objectContaining({ id: "p1", hermes: dockerProfile.hermes }),
        "/tmp/workspace",
      );
      expect(fakeRuntime.createInputs).toEqual([]);
      expect(service.listSessions()).toEqual([]);
      expect(String(error)).toContain("Hermes execution backend validation failed");
      expect(String(error)).not.toContain("canary");
    });

    it("keeps a read-only history row and redacts native create failures", async () => {
      const fakeRuntime = fakeHermesRuntime();
      fakeRuntime.setCreateImpl(async () => {
        throw new Error("upstream leaked sk-secret-value");
      });
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);

      await expect(service.startSession(baseReq(), { send: () => {} })).rejects.toThrow(
        "Hermes session creation failed",
      );

      const [row] = service.listSessions();
      expect(row).toMatchObject({ status: "error", resumable: false });
      if (!row) throw new Error("missing failed history row");
      const binding = db.agentRuntimeBindings.get(row.sessionId);
      expect(binding).toMatchObject({ status: "error", resumable: false });
      const serialized = JSON.stringify(service.loadSessionEvents(row.sessionId));
      expect(serialized).toContain("Hermes session creation failed");
      expect(serialized).not.toContain("sk-secret-value");
    });

    it("persists user and mapped events before delivery, then emits a success result", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const order: string[] = [];
      const append = db.agentEvents.append.bind(db.agentEvents);
      vi.spyOn(db.agentEvents, "append").mockImplementation((input) => {
        append(input);
        order.push(`db:${input.type}`);
      });
      fakeRuntime.setStreamImpl(async (_binding, _prompt, emit) => {
        expect(db.agentEvents.readBySession(_binding.canonicalSessionId).at(-1)?.type).toBe(
          "agent_user",
        );
        emit({
          type: "session.info",
          payload: { model: "deepseek-chat", tools: { core: ["terminal"] } },
        });
        emit({ type: "message.start", payload: {} });
        emit({ type: "message.delta", payload: { text: "你好" } });
        emit({ type: "message.complete", payload: { text: "你好" } });
      });
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), {
        send: (event) => order.push(`sink:${event.type}`),
      });

      service.send(sessionId, "请回复");

      await vi.waitFor(() => {
        expect(db.agentEvents.readBySession(sessionId).at(-1)?.type).toBe("agent_session_result");
      });
      expect(db.agentEvents.readBySession(sessionId).map((row) => row.type)).toEqual([
        "agent_user",
        "agent_session_start",
        "agent_text",
        "agent_text",
        "agent_session_result",
      ]);
      expect(order).toEqual([
        "db:agent_user",
        "db:agent_session_start",
        "sink:agent_session_start",
        "db:agent_text",
        "sink:agent_text",
        "db:agent_text",
        "sink:agent_text",
        "db:agent_session_result",
        "sink:agent_session_result",
      ]);
      expect(db.agentRuntimeBindings.get(sessionId)).toMatchObject({
        status: "idle",
        resumable: true,
      });
    });

    it("never persists sensitive request or response runtime notifications", async () => {
      const fakeRuntime = fakeHermesRuntime();
      fakeRuntime.setStreamImpl(async (_binding, _prompt, emit) => {
        emit({
          type: "secret.request",
          payload: { request_id: "secret-1", prompt: "token", value: "private-value" },
        });
        emit({
          type: "secret.respond",
          payload: { request_id: "secret-1", value: "private-value" },
        });
        emit({
          type: "sudo.request",
          payload: { request_id: "sudo-1", password: "private-password" },
        });
        emit({
          type: "sudo.respond",
          payload: { request_id: "sudo-1", password: "private-password" },
        });
      });
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });

      service.send(sessionId, "run secure flow");
      await vi.waitFor(() => {
        expect(db.agentEvents.readBySession(sessionId).at(-1)?.type).toBe("agent_session_result");
      });

      const serialized = JSON.stringify(service.loadSessionEvents(sessionId));
      expect(db.agentEvents.readBySession(sessionId).map((row) => row.type)).toEqual([
        "agent_user",
        "agent_session_result",
      ]);
      expect(serialized).not.toContain("private-value");
      expect(serialized).not.toContain("private-password");
    });

    it("routes native approvals through RiskGate while sudo and secret stay on sensitive prompts", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const credentials = fakeCredentials();
      const riskGateFixture = fakeGate({ kind: "allow_session" });
      const prompter = {
        requestApproval: vi.fn(async () => "deny" as const),
        requestSudo: vi.fn(async () => "administrator-password"),
        requestSecret: vi.fn(async () => "tool-secret-value"),
        handleResponse: vi.fn(() => true),
        cleanupAll: vi.fn(),
      };
      fakeRuntime.setStreamImpl(async (_binding, _prompt, emit) => {
        emit({
          type: "approval.request",
          payload: {
            skill_id: "shell-skill known-secret-value",
            tool_name: "terminal known-secret-value",
            plugin_name: "trusted-plugin known-secret-value",
            command: "git status known-secret-value",
          },
        });
        emit({
          type: "sudo.request",
          payload: {
            request_id: "deadbeef",
            prompt: "Administrator access",
            command: "sudo launchctl kickstart",
          },
        });
        emit({
          type: "secret.request",
          payload: {
            request_id: "feedface",
            prompt: "Enter service token",
            env_var: "SERVICE_TOKEN",
            value: "must-never-cross-the-prompt-IPC",
          },
        });
      });
      const { service, audits, promptRequests } = makeNativeService(
        fakeRuntime,
        undefined,
        prompter,
        undefined,
        credentials,
        riskGateFixture,
      );
      await service.saveProfile(PROFILE, {
        ref: "apikey:p1",
        secret: "known-secret-value",
      });
      const sessionId = await service.startSession(baseReq(), { send: () => {} });

      service.send(sessionId, "run secure flow");

      await vi.waitFor(() => expect(fakeRuntime.approvalInputs).toHaveLength(1));
      await vi.waitFor(() => expect(fakeRuntime.secretInputs).toHaveLength(1));
      expect(prompter.requestApproval).not.toHaveBeenCalled();
      expect(promptRequests).toEqual([
        {
          businessAction: null,
          category: "hermes-native",
          params: {
            command: "git status [REDACTED]",
            pluginName: "trusted-plugin [REDACTED]",
            toolName: "terminal [REDACTED]",
          },
          riskLevel: "review",
          sessionId,
          skillId: "shell-skill [REDACTED]",
          toolName: "terminal [REDACTED]",
        },
      ]);
      expect(audits).toEqual([
        expect.objectContaining({
          decision: "allow_session",
          automated: false,
          skillId: "shell-skill [REDACTED]",
          toolName: "terminal [REDACTED]",
        }),
      ]);
      expect(JSON.stringify({ audits, promptRequests })).not.toContain("known-secret-value");
      expect(prompter.requestSudo).toHaveBeenCalledWith({
        kind: "sudo",
        sessionId,
        prompt: "Administrator access",
        command: "sudo launchctl kickstart",
      });
      expect(prompter.requestSecret).toHaveBeenCalledWith({
        kind: "secret",
        sessionId,
        prompt: "Enter service token",
        secretName: "SERVICE_TOKEN",
      });
      expect(fakeRuntime.approvalInputs).toEqual([
        { binding: expect.objectContaining({ canonicalSessionId: sessionId }), choice: "session" },
      ]);
      expect(fakeRuntime.sudoInputs).toEqual([
        {
          binding: expect.objectContaining({ canonicalSessionId: sessionId }),
          requestId: "deadbeef",
          password: "administrator-password",
        },
      ]);
      expect(fakeRuntime.secretInputs).toEqual([
        {
          binding: expect.objectContaining({ canonicalSessionId: sessionId }),
          requestId: "feedface",
          value: "tool-secret-value",
        },
      ]);
      expect(JSON.stringify(service.loadSessionEvents(sessionId))).not.toContain(
        "must-never-cross-the-prompt-IPC",
      );
    });

    it.each([
      [{ kind: "allow_once" }, "once", "allow_once"],
      [{ kind: "allow_session" }, "session", "allow_session"],
      [{ kind: "allow_always" }, "always", "allow_always"],
      [{ kind: "deny" }, "deny", "deny"],
    ] as const)("audits native RiskGate decision %s and sends Hermes scope %s", async (userDecision, expectedChoice, expectedAuditDecision) => {
      const fakeRuntime = fakeHermesRuntime();
      const riskGateFixture = fakeGate(userDecision);
      fakeRuntime.setStreamImpl(async (_binding, _prompt, emit) => {
        emit({
          type: "approval.request",
          payload: { plugin_name: "official-plugin", tool_name: "terminal" },
        });
      });
      const { service, audits } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        fakeCredentials(),
        riskGateFixture,
      );
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });

      service.send(sessionId, "run approval mapping");

      await vi.waitFor(() => expect(fakeRuntime.approvalInputs).toHaveLength(1));
      expect(fakeRuntime.approvalInputs[0]?.choice).toBe(expectedChoice);
      expect(audits).toEqual([
        expect.objectContaining({
          sessionId,
          decision: expectedAuditDecision,
          automated: false,
          skillId: "official-plugin",
          toolName: "terminal",
        }),
      ]);
    });

    it("cancels a pending native allow_always when its Profile generation is rotated", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const pendingDecision = deferred<UserDecision>();
      const riskGateFixture = fakeGate(pendingDecision.promise);
      fakeRuntime.setStreamImpl(async (_binding, _prompt, emit) => {
        emit({
          type: "approval.request",
          payload: { plugin_name: "official-plugin", tool_name: "terminal" },
        });
      });
      const { service, audits, promptRequests, savedRules } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        fakeCredentials(),
        riskGateFixture,
      );
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });
      service.send(sessionId, "request approval before rotation");
      await vi.waitFor(() => expect(promptRequests).toHaveLength(1));

      await service.saveProfile({ ...PROFILE, displayName: "Rotated DeepSeek" });
      expect(fakeRuntime.closeInputs).toEqual([
        expect.objectContaining({ canonicalSessionId: sessionId }),
      ]);
      pendingDecision.resolve({ kind: "allow_always" });

      await vi.waitFor(() =>
        expect(audits).toEqual([
          expect.objectContaining({
            sessionId,
            decision: "deny",
            automated: true,
            reason: "request_cancelled",
          }),
        ]),
      );
      expect(savedRules).toEqual([]);
      expect(fakeRuntime.approvalInputs).toEqual([]);
    });

    it("registers a prompted tool secret before later Hermes output is persisted", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const streamDone = deferred<void>();
      let emitRuntime: RuntimeEventSink | undefined;
      const prompter = {
        requestApproval: vi.fn(async () => "deny" as const),
        requestSudo: vi.fn(async () => ""),
        requestSecret: vi.fn(async () => "dynamic-tool-secret"),
        handleResponse: vi.fn(() => true),
        cleanupAll: vi.fn(),
      };
      fakeRuntime.setStreamImpl(async (_binding, _prompt, emit) => {
        emitRuntime = emit;
        emit({ type: "secret.request", payload: { request_id: "feedface" } });
        await streamDone.promise;
      });
      const received: AgentEvent[] = [];
      const { service } = makeNativeService(fakeRuntime, undefined, prompter);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), {
        send: (event) => received.push(event),
      });

      service.send(sessionId, "request then use secret");
      await vi.waitFor(() => expect(fakeRuntime.secretInputs).toHaveLength(1));
      emitRuntime?.({
        type: "message.complete",
        payload: { text: "tool returned dynamic-tool-secret!" },
      });
      streamDone.resolve();
      await vi.waitFor(() => {
        expect(db.agentEvents.readBySession(sessionId).at(-1)?.type).toBe("agent_session_result");
      });

      const serialized = JSON.stringify({ received, stored: service.loadSessionEvents(sessionId) });
      expect(serialized).not.toContain("dynamic-tool-secret");
      expect(serialized).toContain("[REDACTED]");
    });

    it("fails closed without a prompt renderer and sends official cancellation values", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const riskGateFixture = fakeGate({ kind: "deny", reason: "no_renderer" });
      fakeRuntime.setStreamImpl(async (_binding, _prompt, emit) => {
        emit({ type: "approval.request", payload: { command: "dangerous command" } });
        emit({ type: "sudo.request", payload: { request_id: "deadbeef" } });
        emit({ type: "secret.request", payload: { request_id: "feedface" } });
      });
      const { service, audits } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        fakeCredentials(),
        riskGateFixture,
      );
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });

      service.send(sessionId, "run without renderer prompt service");

      await vi.waitFor(() => expect(fakeRuntime.approvalInputs).toHaveLength(1));
      await vi.waitFor(() => expect(fakeRuntime.secretInputs).toHaveLength(1));
      expect(fakeRuntime.approvalInputs[0]?.choice).toBe("deny");
      expect(audits).toEqual([
        expect.objectContaining({ decision: "deny", reason: "no_renderer" }),
      ]);
      expect(fakeRuntime.sudoInputs[0]?.password).toBe("");
      expect(fakeRuntime.secretInputs[0]?.value).toBe("");
    });

    it("fails closed when the injected prompt transport rejects", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const riskGateFixture = fakeGate({ kind: "deny", reason: "ipc_send_error" });
      const prompter = {
        requestApproval: vi.fn(async () => {
          throw new Error("renderer unavailable");
        }),
        requestSudo: vi.fn(async () => {
          throw new Error("renderer unavailable");
        }),
        requestSecret: vi.fn(async () => {
          throw new Error("renderer unavailable");
        }),
        handleResponse: vi.fn(() => false),
        cleanupAll: vi.fn(),
      };
      fakeRuntime.setStreamImpl(async (_binding, _prompt, emit) => {
        emit({ type: "approval.request", payload: {} });
        emit({ type: "sudo.request", payload: { request_id: "deadbeef" } });
        emit({ type: "secret.request", payload: { request_id: "feedface" } });
      });
      const { service, audits } = makeNativeService(
        fakeRuntime,
        undefined,
        prompter,
        undefined,
        fakeCredentials(),
        riskGateFixture,
      );
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });

      service.send(sessionId, "run after renderer failure");

      await vi.waitFor(() => expect(fakeRuntime.approvalInputs).toHaveLength(1));
      await vi.waitFor(() => expect(fakeRuntime.secretInputs).toHaveLength(1));
      expect(prompter.requestApproval).not.toHaveBeenCalled();
      expect(fakeRuntime.approvalInputs[0]?.choice).toBe("deny");
      expect(audits).toEqual([
        expect.objectContaining({ decision: "deny", reason: "ipc_send_error" }),
      ]);
      expect(fakeRuntime.sudoInputs[0]?.password).toBe("");
      expect(fakeRuntime.secretInputs[0]?.value).toBe("");
    });

    it("fails closed when RiskGate itself rejects", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const riskGateFixture = {
        ...fakeGate(),
        gate: {
          check: vi.fn(async () => {
            throw new Error("risk gate unavailable with sensitive diagnostics");
          }),
        } as unknown as RiskGate,
      };
      fakeRuntime.setStreamImpl(async (_binding, _prompt, emit) => {
        emit({ type: "approval.request", payload: { command: "dangerous command" } });
      });
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        fakeCredentials(),
        riskGateFixture,
      );
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });

      service.send(sessionId, "run with unavailable gate");

      await vi.waitFor(() => expect(fakeRuntime.approvalInputs).toHaveLength(1));
      expect(fakeRuntime.approvalInputs[0]?.choice).toBe("deny");
      expect(JSON.stringify(service.loadSessionEvents(sessionId))).not.toContain(
        "sensitive diagnostics",
      );
    });

    it("invalidates bindings and closes active Hermes sessions when their profile is deleted", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });

      service.deleteProfile("p1");

      await vi.waitFor(() => expect(fakeRuntime.closeInputs).toHaveLength(1));
      expect(db.agentRuntimeBindings.get(sessionId)).toMatchObject({
        status: "read_only",
        resumable: false,
      });
      expect(() => service.send(sessionId, "must not resume")).toThrow(/unknown agent session/);
      await expect(service.openSession(sessionId, { send: () => {} })).resolves.toMatchObject({
        recovery: "read_only",
      });
    });

    it("waits for Profile invalidation before persisting a same-ID credential rotation", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const invalidation = deferred<void>();
      fakeRuntime.setInvalidateProfileImpl(async () => invalidation.promise);
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });
      const rotated = { ...PROFILE, displayName: "DeepSeek rotated" };

      const saving = service.saveProfile(rotated);

      await vi.waitFor(() => expect(fakeRuntime.invalidateProfileInputs).toEqual(["p1"]));
      expect(service.listProfiles()[0]?.displayName).toBe("DeepSeek");
      expect(db.agentRuntimeBindings.get(sessionId)).toMatchObject({
        status: "read_only",
        resumable: false,
      });
      expect(() => service.send(sessionId, "must not use the old capability")).toThrow(
        /unknown agent session/,
      );

      invalidation.resolve();
      await expect(saving).resolves.toMatchObject({ displayName: "DeepSeek rotated" });
      expect(fakeRuntime.closeInputs).toHaveLength(1);
      expect(service.listProfiles()[0]?.displayName).toBe("DeepSeek rotated");
    });

    it("rolls back a rotated credential and keeps the old Profile blocked when its DB commit fails", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const credentialValues = new Map<string, string>([["apikey:p1", "old-test-value"]]);
      const credentials: CredentialStore = {
        get: async (ref) => credentialValues.get(ref) ?? null,
        set: async (ref, value) => {
          credentialValues.set(ref, value);
        },
        delete: async (ref) => {
          credentialValues.delete(ref);
        },
      };
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        credentials,
      );
      await service.saveProfile(PROFILE, { ref: "apikey:p1", secret: "old-test-value" });
      vi.spyOn(db.providerProfiles, "save").mockImplementationOnce(() => {
        throw new Error("database unavailable");
      });
      const replacement = {
        ...PROFILE,
        displayName: "Replacement DeepSeek",
        baseUrl: "https://replacement.example.test/v1",
      };

      const error = await service
        .saveProfile(replacement, { ref: "apikey:p1", secret: "new-test-value" })
        .catch((cause) => cause);

      expect(String(error)).toContain("provider Profile save failed");
      expect(String(error)).not.toContain("new-test-value");
      expect(credentialValues.get("apikey:p1")).toBe("old-test-value");
      expect(service.listProfiles()[0]).toMatchObject({
        displayName: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
      });
      expect(db.providerProfiles.listRaw()[0]).toMatchObject({ displayName: "DeepSeek" });
      await expect(service.startSession(baseReq(), { send: () => {} })).rejects.toThrow(
        /profile is unavailable/,
      );

      await expect(
        service.saveProfile(replacement, { ref: "apikey:p1", secret: "new-test-value" }),
      ).resolves.toMatchObject({ displayName: "Replacement DeepSeek" });
      expect(service.listProfiles()[0]).toMatchObject({ displayName: "Replacement DeepSeek" });
    });

    it("rolls back a partially failed credential write without committing Profile metadata", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const credentialValues = new Map<string, string>([["apikey:p1", "old-test-value"]]);
      let failNextWrite = false;
      const credentials: CredentialStore = {
        get: async (ref) => credentialValues.get(ref) ?? null,
        set: async (ref, value) => {
          credentialValues.set(ref, value);
          if (failNextWrite) {
            failNextWrite = false;
            throw new Error("credential write failed with new-test-value");
          }
        },
        delete: async (ref) => {
          credentialValues.delete(ref);
        },
      };
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        credentials,
      );
      await service.saveProfile(PROFILE, { ref: "apikey:p1", secret: "old-test-value" });
      failNextWrite = true;

      const error = await service
        .saveProfile(
          { ...PROFILE, displayName: "Must not commit" },
          { ref: "apikey:p1", secret: "new-test-value" },
        )
        .catch((cause) => cause);

      expect(String(error)).toContain("provider Profile save failed");
      expect(String(error)).not.toContain("new-test-value");
      expect(credentialValues.get("apikey:p1")).toBe("old-test-value");
      expect(service.listProfiles()[0]?.displayName).toBe("DeepSeek");
      expect(db.providerProfiles.listRaw()[0]).toMatchObject({ displayName: "DeepSeek" });
      await expect(service.startSession(baseReq(), { send: () => {} })).rejects.toThrow(
        /profile is unavailable/,
      );
    });

    it("rejects a new endpoint that tries to reuse another Profile credential ref", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const credentialValues = new Map<string, string>([["apikey:p1", "owner-test-value"]]);
      const credentials: CredentialStore = {
        get: async (ref) => credentialValues.get(ref) ?? null,
        set: async (ref, value) => {
          credentialValues.set(ref, value);
        },
        delete: async (ref) => {
          credentialValues.delete(ref);
        },
      };
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        credentials,
      );
      await service.saveProfile(PROFILE, { ref: "apikey:p1", secret: "owner-test-value" });
      const confusedDeputy = {
        ...PROFILE,
        id: "exfil-profile",
        displayName: "Untrusted endpoint",
        baseUrl: "https://untrusted.example.test/v1",
      };

      const withoutSecret = await service.saveProfile(confusedDeputy).catch((cause) => cause);
      const withSecret = await service
        .saveProfile(confusedDeputy, {
          ref: "apikey:p1",
          secret: "attacker-test-value",
        })
        .catch((cause) => cause);

      expect(String(withoutSecret)).toContain("provider Profile credential policy rejected");
      expect(String(withSecret)).toContain("provider Profile credential policy rejected");
      expect(String(withSecret)).not.toContain("attacker-test-value");
      expect(service.listProfiles().map((profile) => profile.id)).toEqual(["p1"]);
      expect(db.providerProfiles.listRaw()).toEqual([expect.objectContaining({ id: "p1" })]);
      expect(credentialValues.get("apikey:p1")).toBe("owner-test-value");
    });

    it("serializes concurrent cross-Profile claims for one credential ref", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const credentialValues = new Map<string, string>();
      const credentials: CredentialStore = {
        get: async (ref) => credentialValues.get(ref) ?? null,
        set: async (ref, value) => {
          credentialValues.set(ref, value);
        },
        delete: async (ref) => {
          credentialValues.delete(ref);
        },
      };
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        credentials,
      );
      const first = {
        ...PROFILE,
        id: "credential-owner-a",
        credentialRef: "apikey:shared-claim",
      };
      const second = {
        ...PROFILE,
        id: "credential-owner-b",
        credentialRef: "apikey:shared-claim",
      };

      const claims = await Promise.allSettled([
        service.saveProfile(first, {
          ref: "apikey:shared-claim",
          secret: "first-owner-test-value",
        }),
        service.saveProfile(second, {
          ref: "apikey:shared-claim",
          secret: "second-owner-test-value",
        }),
      ]);

      expect(claims[0]).toMatchObject({ status: "fulfilled" });
      expect(claims[1]).toMatchObject({ status: "rejected" });
      expect(service.listProfiles().map((profile) => profile.id)).toEqual([first.id]);
      expect(db.providerProfiles.listRaw()).toEqual([expect.objectContaining({ id: first.id })]);
      expect(credentialValues.get("apikey:shared-claim")).toBe("first-owner-test-value");
    });

    it("requires the unified secret when an API-key Profile changes endpoint or provider", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const credentialValues = new Map<string, string>([["apikey:p1", "owner-test-value"]]);
      const credentials: CredentialStore = {
        get: async (ref) => credentialValues.get(ref) ?? null,
        set: async (ref, value) => {
          credentialValues.set(ref, value);
        },
        delete: async (ref) => {
          credentialValues.delete(ref);
        },
      };
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        credentials,
      );
      await service.saveProfile(PROFILE, { ref: "apikey:p1", secret: "owner-test-value" });

      await expect(
        service.saveProfile({
          ...PROFILE,
          baseUrl: "https://replacement.example.test/v1",
        }),
      ).rejects.toThrow("provider Profile credential policy rejected");

      expect(service.listProfiles()[0]).toMatchObject({
        baseUrl: "https://api.deepseek.com/v1",
      });
      expect(credentialValues.get("apikey:p1")).toBe("owner-test-value");
      await expect(
        service.saveProfile({ ...PROFILE, displayName: "Metadata only" }),
      ).resolves.toMatchObject({ displayName: "Metadata only" });
    });

    it("requires a secret for new API-key Profiles and forbids credentials on OAuth Profiles", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const { service } = makeNativeService(fakeRuntime);
      const apiKeyProfile = {
        ...PROFILE,
        id: "new-api-key-profile",
        credentialRef: "apikey:new-api-key-profile",
      };
      const oauthProfile = {
        id: "oauth-profile",
        displayName: "ChatGPT",
        kind: "openai" as const,
        model: "gpt-5.4",
        pricing: null,
        hermes: {
          providerSlug: "openai-codex",
          authMode: "oauth" as const,
          apiMode: "codex_responses" as const,
          executionBackend: "local" as const,
        },
      };

      await expect(service.saveProfile(apiKeyProfile)).rejects.toThrow(
        "provider Profile credential policy rejected",
      );
      await expect(
        service.saveProfile(
          { ...oauthProfile, credentialRef: "oauth:must-not-exist" },
          { ref: "oauth:must-not-exist", secret: "oauth-test-value" },
        ),
      ).rejects.toThrow("provider Profile credential policy rejected");
      await expect(service.saveProfile(oauthProfile)).resolves.toMatchObject({
        id: "oauth-profile",
      });
    });

    it("rejects unsupported OAuth provider, model, and API mode before persistence", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const { service } = makeNativeService(fakeRuntime);
      const supported = {
        id: "oauth-profile",
        displayName: "ChatGPT",
        kind: "openai" as const,
        model: "gpt-5.4",
        pricing: null,
        hermes: {
          providerSlug: "openai-codex",
          authMode: "oauth" as const,
          apiMode: "codex_responses" as const,
          executionBackend: "local" as const,
        },
      };
      const attacks = [
        {
          ...supported,
          id: "bad-oauth-provider",
          hermes: { ...supported.hermes, providerSlug: "untrusted-provider" },
        },
        { ...supported, id: "bad-oauth-model", model: "gpt-5.4-untrusted" },
        {
          ...supported,
          id: "bad-oauth-mode",
          hermes: { ...supported.hermes, apiMode: "chat_completions" as const },
        },
      ];

      for (const attack of attacks) {
        const error = await service.saveProfile(attack).catch((cause) => cause);
        expect(String(error)).toContain("Hermes OAuth Profile is unsupported");
        expect(String(error)).not.toContain(attack.id);
      }
      expect(service.listProfiles()).toEqual([]);
      expect(db.providerProfiles.listRaw()).toEqual([]);
      expect(fakeRuntime.invalidateProfileInputs).toEqual([]);
    });

    it("rejects API-key routing tuples and base URLs that disagree with canonical Profile metadata", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const set = vi.fn(async (_ref: string, _secret: string) => {});
      const credentials: CredentialStore = {
        get: async () => null,
        set,
        delete: async () => {},
      };
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        credentials,
      );
      const attacks = [
        {
          ...PROFILE,
          id: "api-route-provider",
          credentialRef: "apikey:api-route-provider",
          hermes: {
            providerSlug: "anthropic",
            authMode: "api_key" as const,
            apiMode: "chat_completions" as const,
            executionBackend: "local" as const,
          },
        },
        {
          ...PROFILE,
          id: "api-route-mode",
          credentialRef: "apikey:api-route-mode",
          hermes: {
            providerSlug: "deepseek",
            authMode: "api_key" as const,
            apiMode: "codex_responses" as const,
            executionBackend: "local" as const,
          },
        },
        {
          id: "api-route-base-url",
          displayName: "OpenAI with endpoint override",
          kind: "openai" as const,
          baseUrl: "https://attacker.invalid/v1",
          model: "gpt-test",
          credentialRef: "apikey:api-route-base-url",
          pricing: null,
          hermes: {
            providerSlug: "openai-api",
            authMode: "api_key" as const,
            apiMode: "codex_responses" as const,
            executionBackend: "docker" as const,
          },
        },
        {
          id: "api-route-invalid-url",
          displayName: "Invalid custom endpoint",
          kind: "openai-compatible" as const,
          baseUrl: "file:///tmp/not-an-api",
          model: "model-test",
          credentialRef: "apikey:api-route-invalid-url",
          pricing: null,
          hermes: {
            providerSlug: "custom:api-route-invalid-url",
            authMode: "api_key" as const,
            apiMode: "chat_completions" as const,
            executionBackend: "local" as const,
          },
        },
      ];

      for (const attack of attacks) {
        const error = await service
          .saveProfile(attack, {
            ref: attack.credentialRef,
            secret: "attacker-route-test-value",
          })
          .catch((cause) => cause);
        expect(String(error)).toContain("Hermes API-key Profile is unsupported");
        expect(String(error)).not.toContain(attack.id);
        expect(String(error)).not.toContain("attacker.invalid");
      }
      expect(set).not.toHaveBeenCalled();
      expect(service.listProfiles()).toEqual([]);
      expect(db.providerProfiles.listRaw()).toEqual([]);
      expect(fakeRuntime.invalidateProfileInputs).toEqual([]);
    });

    it("skips unsupported OAuth Profiles recovered from dirty SQLite", () => {
      const dirtyProfiles = [
        {
          id: "dirty-oauth-provider",
          displayName: "Dirty OAuth",
          kind: "openai" as const,
          model: "gpt-5.4",
          pricing: null,
          hermes: {
            providerSlug: "untrusted-provider",
            authMode: "oauth" as const,
            apiMode: "codex_responses" as const,
            executionBackend: "local" as const,
          },
        },
        {
          id: "dirty-oauth-model",
          displayName: "Dirty OAuth",
          kind: "openai" as const,
          model: "untrusted-model",
          pricing: null,
          hermes: {
            providerSlug: "openai-codex",
            authMode: "oauth" as const,
            apiMode: "codex_responses" as const,
            executionBackend: "local" as const,
          },
        },
        {
          id: "dirty-oauth-mode",
          displayName: "Dirty OAuth",
          kind: "openai" as const,
          model: "gpt-5.4",
          pricing: null,
          hermes: {
            providerSlug: "openai-codex",
            authMode: "oauth" as const,
            apiMode: "chat_completions" as const,
            executionBackend: "local" as const,
          },
        },
      ];
      for (const profile of dirtyProfiles) db.providerProfiles.save(profile.id, profile);

      const { service } = makeNativeService(fakeHermesRuntime());

      expect(service.listProfiles()).toEqual([]);
      expect(db.providerProfiles.listRaw()).toHaveLength(3);
    });

    it("skips forged API-key routing metadata recovered from dirty SQLite", () => {
      const dirtyProfile = {
        ...PROFILE,
        id: "dirty-api-route",
        credentialRef: "apikey:dirty-api-route",
        hermes: {
          providerSlug: "anthropic",
          authMode: "api_key" as const,
          apiMode: "chat_completions" as const,
          executionBackend: "local" as const,
        },
      };
      db.providerProfiles.save(dirtyProfile.id, dirtyProfile);

      const { service } = makeNativeService(fakeHermesRuntime());

      expect(service.listProfiles()).toEqual([]);
      expect(db.providerProfiles.listRaw()).toEqual([
        expect.objectContaining({ id: dirtyProfile.id }),
      ]);
    });

    it("loads only one owner when dirty SQLite reuses an API credential ref", () => {
      const first = {
        ...PROFILE,
        id: "dirty-credential-owner-a",
        credentialRef: "apikey:dirty-shared",
      };
      const second = {
        ...PROFILE,
        id: "dirty-credential-owner-b",
        credentialRef: "apikey:dirty-shared",
      };
      db.providerProfiles.save(first.id, first);
      db.providerProfiles.save(second.id, second);

      const { service } = makeNativeService(fakeHermesRuntime());

      expect(service.listProfiles().map((profile) => profile.id)).toEqual([first.id]);
      expect(db.providerProfiles.listRaw()).toHaveLength(2);
    });

    it("rechecks the OAuth allowlist before start and resume", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const oauthProfile = {
        id: "oauth-profile",
        displayName: "ChatGPT",
        kind: "openai" as const,
        model: "gpt-5.4",
        pricing: null,
        hermes: {
          providerSlug: "openai-codex",
          authMode: "oauth" as const,
          apiMode: "codex_responses" as const,
          executionBackend: "local" as const,
        },
      };
      const { service } = makeNativeService(fakeRuntime);
      const mutable = await service.saveProfile(oauthProfile);
      db.agentSessions.create("oauth-resume", oauthProfile.model, 1);
      db.agentRuntimeBindings.create({
        sessionId: "oauth-resume",
        profileId: oauthProfile.id,
        workspaceRoot: "/tmp/workspace",
        status: "creating",
        createdAt: 1,
      });
      db.agentRuntimeBindings.attachDurableSession({
        sessionId: "oauth-resume",
        durableSessionId: "durable-oauth",
        status: "idle",
        resumable: true,
        updatedAt: 2,
      });
      mutable.model = "untrusted-model";

      const startError = await service
        .startSession({ ...baseReq(), profileId: oauthProfile.id }, { send: () => {} })
        .catch((cause) => cause);
      const opened = await service.openSession("oauth-resume", { send: () => {} });

      expect(String(startError)).toContain("Hermes OAuth Profile is unsupported");
      expect(String(startError)).not.toContain("untrusted-model");
      expect(opened.recovery).toBe("read_only");
      expect(fakeRuntime.createInputs).toEqual([]);
      expect(fakeRuntime.resumeInputs).toEqual([]);
    });

    it("rechecks canonical API-key routing before start and resume", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const { service } = makeNativeService(fakeRuntime);
      const mutable = await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      db.agentSessions.create("api-route-resume", PROFILE.model, 1);
      db.agentRuntimeBindings.create({
        sessionId: "api-route-resume",
        profileId: PROFILE.id,
        workspaceRoot: "/tmp/workspace",
        status: "creating",
        createdAt: 1,
      });
      db.agentRuntimeBindings.attachDurableSession({
        sessionId: "api-route-resume",
        durableSessionId: "durable-api-route",
        status: "idle",
        resumable: true,
        updatedAt: 2,
      });
      mutable.hermes.providerSlug = "anthropic";

      const startError = await service
        .startSession(baseReq(), { send: () => {} })
        .catch((cause) => cause);
      const opened = await service.openSession("api-route-resume", { send: () => {} });

      expect(String(startError)).toContain("Hermes API-key Profile is unsupported");
      expect(String(startError)).not.toContain("anthropic");
      expect(opened.recovery).toBe("read_only");
      expect(fakeRuntime.createInputs).toEqual([]);
      expect(fakeRuntime.resumeInputs).toEqual([]);
    });

    it("invalidates an existing Profile even when credential rotation leaves metadata unchanged", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);

      await service.saveProfile({ ...PROFILE });

      expect(fakeRuntime.invalidateProfileInputs).toEqual(["p1"]);
      expect(fakeRuntime.closeInputs).toEqual([]);
    });

    it("serializes delete and recreate so the replacement cannot reuse the deleted Profile pool", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const invalidation = deferred<void>();
      fakeRuntime.setInvalidateProfileImpl(async () => invalidation.promise);
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);

      const deleting = service.deleteProfile("p1");
      const recreating = service.saveProfile(
        { ...PROFILE, displayName: "Recreated DeepSeek" },
        PROFILE_CREDENTIAL,
      );

      expect(service.listProfiles()[0]?.displayName).toBe("DeepSeek");
      await expect(service.startSession(baseReq(), { send: () => {} })).rejects.toThrow(
        /profile is unavailable/,
      );
      invalidation.resolve();
      await expect(Promise.all([deleting, recreating])).resolves.toEqual([
        undefined,
        expect.objectContaining({ displayName: "Recreated DeepSeek" }),
      ]);
      expect(fakeRuntime.invalidateProfileInputs).toEqual(["p1"]);
      expect(service.listProfiles()[0]?.displayName).toBe("Recreated DeepSeek");
    });

    it("rolls back a failed Home finalize and does not run a queued OAuth recreation", async () => {
      const fakeRuntime = fakeHermesRuntime();
      let homeState: "active" | "quarantined" | "purged" = "active";
      let stageAttempt = 0;
      const rollbacks: Array<ReturnType<typeof vi.fn>> = [];
      const deleteProfileHome = fakeProfileHomeDeleter(async () => {
        stageAttempt += 1;
        const thisAttempt = stageAttempt;
        homeState = "quarantined";
        const rollback = vi.fn(async () => {
          homeState = "active";
        });
        rollbacks.push(rollback);
        return {
          finalize: vi.fn(async () => {
            if (thisAttempt === 1) throw new Error("finalize failed");
            homeState = "purged";
          }),
          rollback,
        };
      });
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        fakeCredentials(),
        fakeGate(),
        deleteProfileHome,
      );
      await service.saveProfile(OAUTH_PROFILE);

      const deleting = service.deleteProfile(OAUTH_PROFILE.id);
      const recreating = service.saveProfile({
        ...OAUTH_PROFILE,
        displayName: "Must not recreate from a failed delete",
      });
      const [deleteResult, recreateResult] = await Promise.allSettled([deleting, recreating]);

      expect(deleteResult).toMatchObject({ status: "rejected" });
      expect(recreateResult).toMatchObject({ status: "rejected" });
      expect(deleteProfileHome).toHaveBeenCalledTimes(1);
      expect(rollbacks[0]).toHaveBeenCalledOnce();
      expect(homeState).toBe("active");
      expect(service.listProfiles()).toEqual([
        expect.objectContaining({ id: OAUTH_PROFILE.id, displayName: "ChatGPT" }),
      ]);
      expect(db.providerProfiles.listRaw()).toEqual([
        expect.objectContaining({ id: OAUTH_PROFILE.id, displayName: "ChatGPT" }),
      ]);
      await expect(
        service.startSession({ ...baseReq(), profileId: OAUTH_PROFILE.id }, { send: () => {} }),
      ).rejects.toThrow(/profile is unavailable/);

      await expect(service.deleteProfile(OAUTH_PROFILE.id)).resolves.toBeUndefined();
      expect(deleteProfileHome).toHaveBeenCalledTimes(2);
      expect(homeState).toBe("purged");
    });

    it("rolls a quarantined OAuth Home and new key back when Profile save cannot commit", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const credentialValues = new Map<string, string>();
      const credentials: CredentialStore = {
        get: async (ref) => credentialValues.get(ref) ?? null,
        set: async (ref, value) => {
          credentialValues.set(ref, value);
        },
        delete: async (ref) => {
          credentialValues.delete(ref);
        },
      };
      let homeState: "active" | "quarantined" | "purged" = "active";
      const rollback = vi.fn(async () => {
        homeState = "active";
      });
      const finalize = vi.fn(async () => {
        homeState = "purged";
      });
      const deleteProfileHome = fakeProfileHomeDeleter(async () => {
        homeState = "quarantined";
        return { finalize, rollback };
      });
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        credentials,
        fakeGate(),
        deleteProfileHome,
      );
      await service.saveProfile(OAUTH_PROFILE);
      vi.spyOn(db.providerProfiles, "save").mockImplementationOnce(() => {
        throw new Error("database unavailable");
      });
      const replacement = {
        ...PROFILE,
        id: OAUTH_PROFILE.id,
        credentialRef: "apikey:oauth-profile",
      };

      const error = await service
        .saveProfile(replacement, {
          ref: "apikey:oauth-profile",
          secret: "new-transition-test-value",
        })
        .catch((cause) => cause);

      expect(String(error)).toContain("provider Profile save failed");
      expect(String(error)).not.toContain("new-transition-test-value");
      expect(finalize).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledOnce();
      expect(homeState).toBe("active");
      expect(credentialValues.has("apikey:oauth-profile")).toBe(false);
      expect(service.listProfiles()).toEqual([
        expect.objectContaining({
          id: OAUTH_PROFILE.id,
          hermes: expect.objectContaining({ authMode: "oauth" }),
        }),
      ]);
      expect(db.providerProfiles.listRaw()).toEqual([
        expect.objectContaining({
          id: OAUTH_PROFILE.id,
          hermes: expect.objectContaining({ authMode: "oauth" }),
        }),
      ]);
    });

    it("keeps the Home marker when failed save compensation cannot restore SQLite, then recovery follows SQLite", async () => {
      const fakeRuntime = fakeHermesRuntime();
      let homeState: "active" | "quarantined" | "purged" = "active";
      let finalizeAttempts = 0;
      const rollback = vi.fn(async () => {
        homeState = "active";
      });
      const finalize = vi.fn(async () => {
        finalizeAttempts += 1;
        if (finalizeAttempts === 1) throw new Error("first finalize failed");
        homeState = "purged";
      });
      const deleteProfileHome = Object.assign(
        vi.fn(async () => {
          homeState = "quarantined";
          return { finalize, rollback };
        }),
        {
          recover: vi.fn(async (profiles: readonly unknown[]) => {
            const persisted = profiles[0] as { hermes?: { providerSlug?: string } } | undefined;
            if (persisted?.hermes?.providerSlug === "nous") await finalize();
            else await rollback();
            return { blockedProfileIds: [] as string[] };
          }),
        },
      );
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        fakeCredentials(),
        fakeGate(),
        deleteProfileHome,
      );
      await service.saveProfile(OAUTH_PROFILE);
      const persist = db.providerProfiles.save.bind(db.providerProfiles);
      let saveCalls = 0;
      vi.spyOn(db.providerProfiles, "save").mockImplementation((id, profile) => {
        saveCalls += 1;
        if (saveCalls === 2) throw new Error("SQLite compensation failed");
        persist(id, profile);
      });
      const replacement = {
        ...OAUTH_PROFILE,
        displayName: "Nous OAuth",
        model: "anthropic/claude-fable-5",
        hermes: {
          ...OAUTH_PROFILE.hermes,
          providerSlug: "nous",
          apiMode: "chat_completions" as const,
        },
      };

      await expect(service.saveProfile(replacement)).rejects.toThrow(
        "provider Profile save failed",
      );

      expect(rollback).not.toHaveBeenCalled();
      expect(homeState).toBe("quarantined");
      expect(db.providerProfiles.listRaw()).toEqual([
        expect.objectContaining({
          id: OAUTH_PROFILE.id,
          hermes: expect.objectContaining({ providerSlug: "nous" }),
        }),
      ]);
      expect(service.listProfiles()).toEqual([
        expect.objectContaining({
          id: OAUTH_PROFILE.id,
          hermes: expect.objectContaining({ providerSlug: "openai-codex" }),
        }),
      ]);
      expect(service.isProfileAvailableForOAuth(OAUTH_PROFILE.id)).toBe(false);

      await expect(deleteProfileHome.recover(db.providerProfiles.listRaw())).resolves.toEqual({
        blockedProfileIds: [],
      });
      expect(finalize).toHaveBeenCalledTimes(2);
      expect(homeState).toBe("purged");
    });

    it("keeps the Home marker when failed delete compensation cannot restore SQLite", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const rollback = vi.fn(async () => {});
      const deleteProfileHome = fakeProfileHomeDeleter(async () => ({
        finalize: vi.fn(async () => {
          throw new Error("finalize failed");
        }),
        rollback,
      }));
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        fakeCredentials(),
        fakeGate(),
        deleteProfileHome,
      );
      await service.saveProfile(OAUTH_PROFILE);
      vi.spyOn(db.providerProfiles, "save").mockImplementation(() => {
        throw new Error("SQLite compensation failed");
      });

      await expect(service.deleteProfile(OAUTH_PROFILE.id)).rejects.toThrow(
        "provider Profile delete failed",
      );

      expect(rollback).not.toHaveBeenCalled();
      expect(db.providerProfiles.listRaw()).toEqual([]);
      expect(service.listProfiles()).toEqual([expect.objectContaining({ id: OAUTH_PROFILE.id })]);
      expect(service.isProfileAvailableForOAuth(OAUTH_PROFILE.id)).toBe(false);
    });

    it("keeps the Home marker when credential compensation fails after an authority save", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const credentialValues = new Map<string, string>();
      let failCredentialDelete = false;
      const credentials: CredentialStore = {
        get: async (ref) => credentialValues.get(ref) ?? null,
        set: async (ref, value) => {
          credentialValues.set(ref, value);
        },
        delete: async (ref) => {
          if (failCredentialDelete) throw new Error("credential compensation failed");
          credentialValues.delete(ref);
        },
      };
      const rollback = vi.fn(async () => {});
      const deleteProfileHome = fakeProfileHomeDeleter(async () => ({
        finalize: vi.fn(async () => {
          throw new Error("finalize failed");
        }),
        rollback,
      }));
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        credentials,
        fakeGate(),
        deleteProfileHome,
      );
      await service.saveProfile(OAUTH_PROFILE);
      failCredentialDelete = true;
      const replacement = {
        ...PROFILE,
        id: OAUTH_PROFILE.id,
        credentialRef: "apikey:oauth-profile",
      };

      await expect(
        service.saveProfile(replacement, {
          ref: "apikey:oauth-profile",
          secret: "new-compensation-test-value",
        }),
      ).rejects.toThrow("provider Profile save failed");

      expect(rollback).not.toHaveBeenCalled();
      expect(credentialValues.get("apikey:oauth-profile")).toBe("new-compensation-test-value");
      expect(db.providerProfiles.listRaw()).toEqual([
        expect.objectContaining({
          id: OAUTH_PROFILE.id,
          hermes: expect.objectContaining({ authMode: "oauth" }),
        }),
      ]);
      expect(service.isProfileAvailableForOAuth(OAUTH_PROFILE.id)).toBe(false);
    });

    it("quarantines same-ID OAuth and API-key authority transitions without clearing on backend-only edits", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const credentialValues = new Map<string, string>();
      const credentials: CredentialStore = {
        get: async (ref) => credentialValues.get(ref) ?? null,
        set: async (ref, value) => {
          credentialValues.set(ref, value);
        },
        delete: async (ref) => {
          credentialValues.delete(ref);
        },
      };
      const finalizedTransitions: Array<{
        oldAuthorityHash: string;
        newAuthorityHash: string | null;
      }> = [];
      const deleteProfileHome = fakeProfileHomeDeleter(async (_profileId, transition) => ({
        finalize: vi.fn(async () => {
          finalizedTransitions.push(transition);
        }),
        rollback: vi.fn(async () => {}),
      }));
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        credentials,
        fakeGate(),
        deleteProfileHome,
      );
      await service.saveProfile(OAUTH_PROFILE);
      const apiKeyProfile = {
        ...PROFILE,
        id: OAUTH_PROFILE.id,
        credentialRef: "apikey:oauth-profile",
      };

      await service.saveProfile(apiKeyProfile, {
        ref: "apikey:oauth-profile",
        secret: "transition-test-value",
      });
      expect(credentialValues.get("apikey:oauth-profile")).toBe("transition-test-value");
      await service.saveProfile(OAUTH_PROFILE);

      expect(credentialValues.has("apikey:oauth-profile")).toBe(false);
      expect(finalizedTransitions).toHaveLength(2);
      expect(finalizedTransitions.every((transition) => transition.newAuthorityHash !== null)).toBe(
        true,
      );
      await service.saveProfile({
        ...OAUTH_PROFILE,
        hermes: { ...OAUTH_PROFILE.hermes, executionBackend: "docker" as const },
      });
      expect(deleteProfileHome).toHaveBeenCalledTimes(2);
    });

    it("drains OAuth login before runtime invalidation and keeps login unavailable through Home finalize", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const oauthDrain = deferred<void>();
      const homeFinalize = deferred<void>();
      const order: string[] = [];
      const invalidateOAuthProfile = vi.fn(async () => {
        order.push("oauth-begin");
        await oauthDrain.promise;
        order.push("oauth-done");
      });
      fakeRuntime.setInvalidateProfileImpl(async () => {
        order.push("runtime");
      });
      const deleteProfileHome = fakeProfileHomeDeleter(async () => {
        order.push("home-stage");
        return {
          finalize: vi.fn(async () => {
            order.push("home-finalize");
            await homeFinalize.promise;
          }),
          rollback: vi.fn(async () => {}),
        };
      });
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        fakeCredentials(),
        fakeGate(),
        deleteProfileHome,
        invalidateOAuthProfile,
      );
      await service.saveProfile(OAUTH_PROFILE);
      expect(service.isProfileAvailableForOAuth(OAUTH_PROFILE.id)).toBe(true);

      const saving = service.saveProfile({
        ...OAUTH_PROFILE,
        displayName: "Nous OAuth",
        model: "anthropic/claude-fable-5",
        hermes: {
          ...OAUTH_PROFILE.hermes,
          providerSlug: "nous",
          apiMode: "chat_completions" as const,
        },
      });

      expect(service.isProfileAvailableForOAuth(OAUTH_PROFILE.id)).toBe(false);
      await vi.waitFor(() => expect(invalidateOAuthProfile).toHaveBeenCalledWith(OAUTH_PROFILE.id));
      expect(order).toEqual(["oauth-begin"]);
      expect(fakeRuntime.invalidateProfileInputs).toEqual([]);
      expect(deleteProfileHome).not.toHaveBeenCalled();

      oauthDrain.resolve();
      await vi.waitFor(() => expect(order).toContain("home-finalize"));
      expect(order).toEqual([
        "oauth-begin",
        "oauth-done",
        "runtime",
        "home-stage",
        "home-finalize",
      ]);
      expect(service.isProfileAvailableForOAuth(OAUTH_PROFILE.id)).toBe(false);

      homeFinalize.resolve();
      await expect(saving).resolves.toMatchObject({
        id: OAUTH_PROFILE.id,
        hermes: expect.objectContaining({ providerSlug: "nous" }),
      });
      expect(service.isProfileAvailableForOAuth(OAUTH_PROFILE.id)).toBe(true);
    });

    it("drains OAuth login before deleting runtime state or staging the Profile Home", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const oauthDrain = deferred<void>();
      const invalidateOAuthProfile = vi.fn(async () => oauthDrain.promise);
      const deleteProfileHome = fakeProfileHomeDeleter(async () => ({
        finalize: vi.fn(async () => {}),
        rollback: vi.fn(async () => {}),
      }));
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        fakeCredentials(),
        fakeGate(),
        deleteProfileHome,
        invalidateOAuthProfile,
      );
      await service.saveProfile(OAUTH_PROFILE);

      const deleting = service.deleteProfile(OAUTH_PROFILE.id);
      expect(service.isProfileAvailableForOAuth(OAUTH_PROFILE.id)).toBe(false);
      await vi.waitFor(() => expect(invalidateOAuthProfile).toHaveBeenCalledWith(OAUTH_PROFILE.id));
      expect(fakeRuntime.invalidateProfileInputs).toEqual([]);
      expect(deleteProfileHome).not.toHaveBeenCalled();

      oauthDrain.resolve();
      await expect(deleting).resolves.toBeUndefined();
      expect(fakeRuntime.invalidateProfileInputs).toEqual([OAUTH_PROFILE.id]);
      expect(deleteProfileHome).toHaveBeenCalledOnce();
      expect(service.listProfiles()).toEqual([]);
      expect(service.isProfileAvailableForOAuth(OAUTH_PROFILE.id)).toBe(false);
    });

    it("fails closed when OAuth login invalidation cannot drain", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const deleteProfileHome = fakeProfileHomeDeleter(async () => ({
        finalize: vi.fn(async () => {}),
        rollback: vi.fn(async () => {}),
      }));
      let invalidationAttempts = 0;
      const invalidateOAuthProfile = vi.fn(async () => {
        invalidationAttempts += 1;
        if (invalidationAttempts === 1) throw new Error("PTY drain leaked detail");
      });
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        fakeCredentials(),
        fakeGate(),
        deleteProfileHome,
        invalidateOAuthProfile,
      );
      await service.saveProfile(OAUTH_PROFILE);

      const error = await service
        .saveProfile({ ...OAUTH_PROFILE, displayName: "Must not persist" })
        .catch((cause) => cause);

      expect(String(error)).toContain("provider Profile invalidation failed");
      expect(String(error)).not.toContain("PTY drain leaked detail");
      expect(fakeRuntime.invalidateProfileInputs).toEqual([]);
      expect(deleteProfileHome).not.toHaveBeenCalled();
      expect(service.listProfiles()).toEqual([
        expect.objectContaining({ id: OAUTH_PROFILE.id, displayName: "ChatGPT" }),
      ]);
      expect(service.isProfileAvailableForOAuth(OAUTH_PROFILE.id)).toBe(false);

      await expect(
        service.saveProfile({ ...OAUTH_PROFILE, displayName: "Retry succeeded" }),
      ).resolves.toMatchObject({ displayName: "Retry succeeded" });
      expect(service.isProfileAvailableForOAuth(OAUTH_PROFILE.id)).toBe(true);
    });

    it("keeps a failed Profile deletion retryable without reviving its sessions", async () => {
      const fakeRuntime = fakeHermesRuntime();
      let attempts = 0;
      fakeRuntime.setInvalidateProfileImpl(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("cleanup failed");
      });
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });

      await expect(service.deleteProfile("p1")).rejects.toThrow(
        "Hermes profile invalidation failed",
      );

      expect(service.listProfiles().map((profile) => profile.id)).toEqual(["p1"]);
      expect(db.providerProfiles.listRaw()).toHaveLength(1);
      expect(db.agentRuntimeBindings.get(sessionId)).toMatchObject({
        status: "read_only",
        resumable: false,
      });
      expect(() => service.send(sessionId, "must remain revoked")).toThrow(/unknown agent session/);
      await expect(service.startSession(baseReq(), { send: () => {} })).rejects.toThrow(
        /profile is unavailable/,
      );

      await expect(service.deleteProfile("p1")).resolves.toBeUndefined();
      expect(fakeRuntime.invalidateProfileInputs).toEqual(["p1", "p1"]);
      expect(service.listProfiles()).toEqual([]);
    });

    it("keeps the old registry entry blocked and retryable when Profile deletion cannot commit", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      vi.spyOn(db.providerProfiles, "delete").mockImplementationOnce(() => {
        throw new Error("database unavailable");
      });

      await expect(service.deleteProfile("p1")).rejects.toThrow("provider Profile delete failed");

      expect(service.listProfiles()).toEqual([expect.objectContaining({ id: "p1" })]);
      expect(db.providerProfiles.listRaw()).toEqual([expect.objectContaining({ id: "p1" })]);
      await expect(service.startSession(baseReq(), { send: () => {} })).rejects.toThrow(
        /profile is unavailable/,
      );

      await expect(service.deleteProfile("p1")).resolves.toBeUndefined();
      expect(service.listProfiles()).toEqual([]);
      expect(db.providerProfiles.listRaw()).toEqual([]);
    });

    it("serializes credential deletion before a same-ID Profile recreation writes its new key", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const deletion = deferred<void>();
      const credentialValues = new Map<string, string>([["apikey:p1", "old-test-value"]]);
      const writes: string[] = [];
      const credentials: CredentialStore = {
        get: async (ref) => credentialValues.get(ref) ?? null,
        set: async (ref, value) => {
          writes.push(ref);
          credentialValues.set(ref, value);
        },
        delete: async (ref) => {
          await deletion.promise;
          credentialValues.delete(ref);
        },
      };
      const { service } = makeNativeService(
        fakeRuntime,
        undefined,
        undefined,
        undefined,
        credentials,
      );
      await service.saveProfile(PROFILE, { ref: "apikey:p1", secret: "old-test-value" });
      writes.length = 0;

      const deleting = service.deleteProfile("p1");
      const recreating = service.saveProfile(
        { ...PROFILE, displayName: "Recreated DeepSeek" },
        { ref: "apikey:p1", secret: "new-test-value" },
      );
      await vi.waitFor(() => expect(fakeRuntime.invalidateProfileInputs).toEqual(["p1"]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writes).toEqual([]);
      expect(credentialValues.get("apikey:p1")).toBe("old-test-value");

      deletion.resolve();
      await expect(Promise.all([deleting, recreating])).resolves.toEqual([
        undefined,
        expect.objectContaining({ displayName: "Recreated DeepSeek" }),
      ]);
      expect(writes).toEqual(["apikey:p1"]);
      expect(credentialValues.get("apikey:p1")).toBe("new-test-value");
    });

    it("revokes sessions and stops the Profile pool even when binding invalidation fails", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });
      vi.spyOn(db.agentRuntimeBindings, "invalidateProfile").mockImplementationOnce(() => {
        throw new Error("database unavailable");
      });

      await expect(service.saveProfile({ ...PROFILE })).rejects.toThrow(
        "Hermes profile invalidation failed",
      );

      expect(fakeRuntime.invalidateProfileInputs).toEqual(["p1"]);
      expect(fakeRuntime.closeInputs).toHaveLength(1);
      expect(() => service.send(sessionId, "must remain revoked")).toThrow(/unknown agent session/);
      await expect(service.startSession(baseReq(), { send: () => {} })).rejects.toThrow(
        /profile is unavailable/,
      );
      await expect(service.openSession(sessionId, { send: () => {} })).resolves.toMatchObject({
        recovery: "read_only",
      });
    });

    it("rejects a session launch that captured a Profile before same-ID invalidation", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const workspace = deferred<string>();
      const { service } = makeNativeService(
        fakeRuntime,
        vi.fn(async () => workspace.promise),
      );
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);

      const starting = service.startSession(baseReq(), { send: () => {} });
      const saving = service.saveProfile({ ...PROFILE });
      workspace.resolve("/workspace/project");

      await expect(starting).rejects.toThrow(
        "Hermes provider profile changed during session launch",
      );
      await expect(saving).resolves.toMatchObject({ id: "p1" });
      expect(fakeRuntime.invalidateProfileInputs).toEqual(["p1", "p1"]);
      expect(fakeRuntime.createInputs).toEqual([]);
    });

    it("drains an in-flight Profile launch and invalidates again before saving replacement metadata", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const creation = deferred<RuntimeBinding>();
      fakeRuntime.setCreateImpl(async () => creation.promise);
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const starting = service.startSession(baseReq(), { send: () => {} });
      await vi.waitFor(() => expect(fakeRuntime.createInputs).toHaveLength(1));

      const saving = service.saveProfile({ ...PROFILE, displayName: "Replacement DeepSeek" });
      await vi.waitFor(() => expect(fakeRuntime.invalidateProfileInputs).toEqual(["p1"]));
      let saveSettled = false;
      void saving.then(
        () => {
          saveSettled = true;
        },
        () => {
          saveSettled = true;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(saveSettled).toBe(false);

      creation.resolve(
        runtimeBinding(fakeRuntime.createInputs[0]?.canonicalSessionId ?? "missing"),
      );
      await expect(starting).rejects.toThrow("Hermes session creation failed");
      await expect(saving).resolves.toMatchObject({ displayName: "Replacement DeepSeek" });
      expect(fakeRuntime.invalidateProfileInputs).toEqual(["p1", "p1"]);
      expect(db.agentRuntimeBindings.listResumable()).toEqual([]);
      expect(
        db.agentRuntimeBindings.get(fakeRuntime.createInputs[0]?.canonicalSessionId ?? ""),
      ).toMatchObject({
        status: "read_only",
        resumable: false,
      });
    });

    it("does not let an in-flight turn re-enable a binding after profile deletion", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const streamDone = deferred<void>();
      fakeRuntime.setStreamImpl(async () => streamDone.promise);
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });
      service.send(sessionId, "in flight");
      await vi.waitFor(() => expect(fakeRuntime.streamInputs).toHaveLength(1));

      service.deleteProfile("p1");
      streamDone.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(db.agentRuntimeBindings.get(sessionId)).toMatchObject({
        status: "read_only",
        resumable: false,
      });
      expect(
        db.agentEvents.readBySession(sessionId).some((row) => row.type === "agent_session_result"),
      ).toBe(false);
    });

    it("does not forward a sensitive prompt response after its profile is revoked", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const secretResponse = deferred<string>();
      const prompter = {
        requestApproval: vi.fn(async () => "deny" as const),
        requestSudo: vi.fn(async () => ""),
        requestSecret: vi.fn(async () => secretResponse.promise),
        handleResponse: vi.fn(() => false),
        cleanupAll: vi.fn(),
      };
      fakeRuntime.setStreamImpl(async (_binding, _prompt, emit) => {
        emit({ type: "secret.request", payload: { request_id: "feedface" } });
      });
      const { service } = makeNativeService(fakeRuntime, undefined, prompter);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });
      service.send(sessionId, "request a secret");
      await vi.waitFor(() => expect(prompter.requestSecret).toHaveBeenCalledOnce());

      service.deleteProfile("p1");
      secretResponse.resolve("must-not-reach-the-runtime");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(fakeRuntime.secretInputs).toEqual([]);
    });

    it("persists an error result and redacted upstream text when a Hermes turn fails", async () => {
      const fakeRuntime = fakeHermesRuntime();
      fakeRuntime.setStreamImpl(async (_binding, _prompt, emit) => {
        emit({
          type: "message.complete",
          payload: {
            status: "error",
            text: "API call failed after 3 retries: Connection error. test-api-key-value",
          },
        });
        throw new Error("provider exposed sk-never-persist-this");
      });
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });

      service.send(sessionId, "trigger failure");
      await vi.waitFor(() => {
        expect(db.agentRuntimeBindings.get(sessionId)).toMatchObject({
          status: "error",
          resumable: true,
          durableSessionId: "durable-1",
        });
      });

      const events = service.loadSessionEvents(sessionId) as AgentEvent[];
      const serialized = JSON.stringify(events);
      const results = events.filter((event) => event.type === "agent_session_result");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        type: "agent_session_result",
        subtype: "error",
        errorMessage: "Hermes session stream failed",
      });
      expect(results).not.toContainEqual(expect.objectContaining({ subtype: "success" }));
      expect(serialized).toContain("API call failed after 3 retries: Connection error. [REDACTED]");
      expect(serialized).toContain("Hermes session stream failed");
      expect(serialized).not.toContain("test-api-key-value");
      expect(serialized).not.toContain("sk-never-persist-this");
    });

    it("interrupts the native binding and marks an in-flight turn aborted", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const streamDone = deferred<void>();
      fakeRuntime.setStreamImpl(async () => streamDone.promise);
      fakeRuntime.setInterruptImpl(async () => streamDone.resolve());
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });

      service.send(sessionId, "long request");
      await vi.waitFor(() => expect(fakeRuntime.streamInputs).toHaveLength(1));
      service.abort(sessionId);

      await vi.waitFor(() => expect(fakeRuntime.interruptInputs).toHaveLength(1));
      await vi.waitFor(() => {
        expect(db.agentRuntimeBindings.get(sessionId)).toMatchObject({ status: "interrupted" });
      });
      await vi.waitFor(() => {
        expect(
          service
            .loadSessionEvents(sessionId)
            .some((event) => (event as AgentEvent).type === "agent_session_result"),
        ).toBe(true);
      });
      const result = service
        .loadSessionEvents(sessionId)
        .find((event) => (event as AgentEvent).type === "agent_session_result") as AgentEvent;
      expect(result).toMatchObject({ type: "agent_session_result", subtype: "aborted" });
    });

    it("returns replay immediately, resumes in the background, and reuses the live session", async () => {
      const first = makeNativeService();
      await first.service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await first.service.startSession(baseReq(), { send: () => {} });
      first.service.send(sessionId, "persisted prompt");
      await vi.waitFor(() => {
        expect(
          db.agentEvents
            .readBySession(sessionId)
            .some((row) => row.type === "agent_session_result"),
        ).toBe(true);
      });

      const fakeRuntime = fakeHermesRuntime();
      const resumeDone = deferred<RuntimeBinding>();
      fakeRuntime.setResumeImpl(async () => resumeDone.promise);
      const second = makeNativeService(fakeRuntime);
      const sinkEvents: AgentEvent[] = [];

      const opened = await second.service.openSession(sessionId, {
        send: (event) => sinkEvents.push(event),
      });

      expect(opened.recovery).toBe("resuming");
      expect(opened.events).toEqual(second.service.loadSessionEvents(sessionId));
      await vi.waitFor(() => expect(fakeRuntime.resumeInputs).toHaveLength(1));
      expect(fakeRuntime.resumeInputs[0]).toMatchObject({
        canonicalSessionId: sessionId,
        durableRuntimeSessionId: "durable-1",
        workspaceRoot: "/tmp/workspace",
      });
      expect(second.validateWorkspaceRoot).toHaveBeenCalledWith("/tmp/workspace");

      resumeDone.resolve({
        canonicalSessionId: sessionId,
        liveRuntimeSessionId: "resumed-live",
        durableRuntimeSessionId: "durable-1",
      });
      await vi.waitFor(() => {
        expect(db.agentRuntimeBindings.get(sessionId)).toMatchObject({ status: "idle" });
      });
      const live = await second.service.openSession(sessionId, { send: () => {} });
      expect(live.recovery).toBe("live");
      expect(fakeRuntime.resumeInputs).toHaveLength(1);
      expect(sinkEvents).toEqual([]);
    });

    it("keeps failed resume read-only and allows an explicit retry", async () => {
      const first = makeNativeService();
      await first.service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await first.service.startSession(baseReq(), { send: () => {} });

      const fakeRuntime = fakeHermesRuntime();
      fakeRuntime.setResumeImpl(async () => {
        throw new Error("oauth-token-should-never-leak");
      });
      const second = makeNativeService(fakeRuntime);
      const firstOpen = await second.service.openSession(sessionId, { send: () => {} });
      expect(firstOpen.recovery).toBe("resuming");
      await vi.waitFor(() => {
        expect(db.agentRuntimeBindings.get(sessionId)).toMatchObject({
          status: "read_only",
          resumable: true,
        });
      });
      expect(JSON.stringify(second.service.loadSessionEvents(sessionId))).not.toContain(
        "oauth-token-should-never-leak",
      );

      fakeRuntime.setResumeImpl(async (input) => ({
        canonicalSessionId: input.canonicalSessionId,
        liveRuntimeSessionId: "retry-live",
        durableRuntimeSessionId: input.durableRuntimeSessionId,
      }));
      const retry = await second.service.openSession(sessionId, { send: () => {} });
      expect(retry.recovery).toBe("resuming");
      await vi.waitFor(() => expect(fakeRuntime.resumeInputs).toHaveLength(2));
      await vi.waitFor(() => {
        expect(db.agentRuntimeBindings.get(sessionId)).toMatchObject({ status: "idle" });
      });
    });

    it("revalidates a persisted workspace before resume and stays read-only if it expired", async () => {
      const first = makeNativeService();
      await first.service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await first.service.startSession(baseReq(), { send: () => {} });
      const fakeRuntime = fakeHermesRuntime();
      const validateWorkspaceRoot = vi.fn(async () => {
        throw new Error("workspace removed");
      });
      const second = makeNativeService(fakeRuntime, validateWorkspaceRoot);

      const opened = await second.service.openSession(sessionId, { send: () => {} });

      expect(opened.recovery).toBe("resuming");
      await vi.waitFor(() => {
        expect(db.agentRuntimeBindings.get(sessionId)).toMatchObject({
          status: "read_only",
          resumable: true,
        });
      });
      expect(validateWorkspaceRoot).toHaveBeenCalledWith("/tmp/workspace");
      expect(fakeRuntime.resumeInputs).toEqual([]);
    });

    it("does not persist a user message that was rejected as a concurrent native turn", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const streamDone = deferred<void>();
      fakeRuntime.setStreamImpl(async () => streamDone.promise);
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const sessionId = await service.startSession(baseReq(), { send: () => {} });
      service.send(sessionId, "first");
      await vi.waitFor(() => expect(fakeRuntime.streamInputs).toHaveLength(1));

      expect(() => service.send(sessionId, "second must not enter history")).toThrow(
        "Hermes session is already streaming",
      );

      const userEvents = service
        .loadSessionEvents(sessionId)
        .filter((event) => (event as { type?: string }).type === "agent_user");
      expect(userEvents).toEqual([expect.objectContaining({ text: "first" })]);
      streamDone.resolve();
    });

    it("isolates multiple sessions and closes them before disposing the runtime", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const first = await service.startSession(baseReq(), { send: () => {} });
      const second = await service.startSession(baseReq(), { send: () => {} });

      expect(first).not.toBe(second);
      expect(fakeRuntime.createInputs.map((input) => input.canonicalSessionId)).toEqual([
        first,
        second,
      ]);

      await service.disposeAll();
      expect(fakeRuntime.closeInputs.map((binding) => binding.canonicalSessionId)).toEqual([
        first,
        second,
      ]);
      expect(fakeRuntime.calls.at(-1)).toBe("dispose");
      expect(fakeRuntime.calls.indexOf("dispose")).toBeGreaterThan(
        fakeRuntime.calls.lastIndexOf("close"),
      );
    });

    it("drains a slow workspace launch during shutdown without creating runtime or binding state", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const workspace = deferred<string>();
      const { service } = makeNativeService(
        fakeRuntime,
        vi.fn(async () => workspace.promise),
      );
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const starting = service.startSession(baseReq(), { send: () => {} });

      const disposing = service.disposeAll();
      let disposed = false;
      void disposing.then(() => {
        disposed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disposed).toBe(false);

      workspace.resolve("/tmp/workspace");
      await expect(starting).rejects.toThrow("agent service is disposed");
      await disposing;
      expect(fakeRuntime.createInputs).toEqual([]);
      expect(service.listSessions()).toEqual([]);
      expect(fakeRuntime.calls.at(-1)).toBe("dispose");
    });

    it("drains and closes a slow runtime launch without attaching it after shutdown", async () => {
      const fakeRuntime = fakeHermesRuntime();
      const creation = deferred<RuntimeBinding>();
      fakeRuntime.setCreateImpl(async () => creation.promise);
      const attach = vi.spyOn(db.agentRuntimeBindings, "attachDurableSession");
      const { service } = makeNativeService(fakeRuntime);
      await service.saveProfile(PROFILE, PROFILE_CREDENTIAL);
      const starting = service.startSession(baseReq(), { send: () => {} });
      await vi.waitFor(() => expect(fakeRuntime.createInputs).toHaveLength(1));

      const disposing = service.disposeAll();
      let disposed = false;
      void disposing.then(() => {
        disposed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disposed).toBe(false);

      const sessionId = fakeRuntime.createInputs[0]?.canonicalSessionId ?? "missing";
      creation.resolve(runtimeBinding(sessionId));
      await expect(starting).rejects.toThrow("agent service is disposed");
      await disposing;

      expect(attach).not.toHaveBeenCalled();
      expect(fakeRuntime.closeInputs).toEqual([
        expect.objectContaining({ canonicalSessionId: sessionId }),
      ]);
      expect(() => service.send(sessionId, "must not attach")).toThrow(/unknown agent session/);
      expect(fakeRuntime.calls.indexOf("dispose")).toBeGreaterThan(
        fakeRuntime.calls.lastIndexOf("close"),
      );
    });
  });
});

function baseReq() {
  return {
    profileId: "p1",
    workspaceRoot: "/tmp/workspace",
    enabledSites: [] as string[],
    maxSteps: 50,
    budgetUsd: null,
    mcpServers: [] as { name: string; command: string; args?: string[] }[],
  };
}
