// AgentService：自建 agent loop 的 desktop 主进程接线（M0 spike）。
//
// 职责：
// - ProfileRegistry（@opentrad/model-providers 内存实现）+ SQLite provider_profiles 持久化
// - 每会话一个 ToolHost：审批钩子桥接现有 RiskGate 服务（safe 直放 / review 弹窗 / blocked 拒绝，
//   均由 RiskGate.check 四步判断实现；deny 语义映射回 ToolApprovalHook 的 deny）
// - createAgentSession 会话管理（多会话 Map；M0 单窗口，webContents 由 sink 抽象）
// - AgentEvent：先落 SQLite agent_events（回放旁证），再经 sink 推 renderer
//
// 依赖全部构造注入（gate / db services / credentials / 工厂函数），单测不 import electron。

import { randomUUID } from "node:crypto";
import { type AgentSessionHandle, createAgentSession } from "@opentrad/agent-core";
import { registerBbSites } from "@opentrad/connectors";
import {
  ApiKeyBackend,
  type ChatBackend,
  type CredentialStore,
  ProfileRegistry,
  type ProviderProfile,
} from "@opentrad/model-providers";
import type { RiskGate } from "@opentrad/risk-gate";
import type { AgentEvent, AgentMcpServerConfig, AgentStartSessionRequest } from "@opentrad/shared";
import {
  type McpMountHandle,
  type McpServerConfig,
  mountMcpServer,
  type ToolApprovalHook,
  ToolHost,
} from "@opentrad/tool-host";
import type { AgentEventService, ProviderProfileService } from "./db";

// 事件出口抽象：生产 = webContents.send 包装（见 ipc/agent.ts）；单测 = 数组收集器
export interface AgentEventSink {
  send(event: AgentEvent): void;
}

// 审批钩子：ToolHost → RiskGate 桥接。
// 三级映射由 RiskGate.check 内部完成（gate.ts 四步判断）：
// - blocked → 自动 deny（reason=blocked_policy）
// - safe（无 businessAction）→ 自动 allow，不弹窗
// - review / safe+businessAction → 规则命中自动决策，否则 IpcRiskGatePrompter 弹窗
// deny 语义映射：CheckResult.decision=deny（含超时/无窗口 graceful degrade）→ hook deny，
// 拒绝原因作为 tool result 喂回模型（loop 自愈，见 tool-host/types.ts）。
export function createRiskGateApprovalHook(gate: RiskGate, sessionId: string): ToolApprovalHook {
  return async (tool, input) => {
    const result = await gate.check({
      sessionId,
      // M0 spike：agent 会话无 skill 上下文（skill 合成接线在 M1）
      skillId: null,
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      params: input,
      businessAction: tool.businessAction,
    });
    if (result.decision === "deny") {
      return { decision: "deny", reason: result.reason };
    }
    return { decision: "allow" };
  };
}

interface ActiveSession {
  handle: AgentSessionHandle;
  mounts: McpMountHandle[];
  sink: AgentEventSink;
  unsubscribe: () => void;
  seq: number;
  ended: boolean;
}

export interface AgentServiceDeps {
  profiles: ProviderProfileService;
  agentEvents: AgentEventService;
  credentials: CredentialStore;
  gate: RiskGate;
}

// 工厂注入口：单测替换（fake backend / fake session / fake mcp 连接），生产走默认实现
export interface AgentServiceFactories {
  createBackend?: (profile: ProviderProfile, credentials: CredentialStore) => ChatBackend;
  createSession?: typeof createAgentSession;
  mountMcp?: (host: ToolHost, config: McpServerConfig) => Promise<McpMountHandle>;
}

export class AgentService {
  private readonly registry = new ProfileRegistry();
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly createBackend: NonNullable<AgentServiceFactories["createBackend"]>;
  private readonly createSession: typeof createAgentSession;
  private readonly mountMcp: NonNullable<AgentServiceFactories["mountMcp"]>;

  constructor(
    private readonly deps: AgentServiceDeps,
    factories: AgentServiceFactories = {},
  ) {
    this.createBackend =
      factories.createBackend ??
      ((profile, credentials) => new ApiKeyBackend(profile, credentials));
    this.createSession = factories.createSession ?? createAgentSession;
    this.mountMcp = factories.mountMcp ?? ((host, config) => mountMcpServer(host, config));

    // 启动时从 SQLite 回灌 registry；单行校验失败跳过（脏数据保护）
    for (const raw of this.deps.profiles.listRaw()) {
      try {
        this.registry.register(raw);
      } catch (err) {
        console.error("[agent-service] skipping invalid persisted profile", err);
      }
    }
  }

  // ----- profiles -----

  listProfiles(): ProviderProfile[] {
    return this.registry.list();
  }

  // zod 校验在 registry.register 内（ProviderProfileSchema.parse）；通过后同步持久化
  saveProfile(raw: unknown): ProviderProfile {
    const profile = this.registry.register(raw);
    this.deps.profiles.save(profile.id, profile);
    return profile;
  }

  deleteProfile(id: string): void {
    this.registry.remove(id);
    this.deps.profiles.delete(id);
  }

  // ----- sessions -----

  async startSession(req: AgentStartSessionRequest, sink: AgentEventSink): Promise<string> {
    const profile = this.registry.get(req.profileId);
    if (!profile) {
      throw new Error(`unknown provider profile: ${req.profileId}`);
    }
    const sessionId = randomUUID();
    const toolHost = new ToolHost(createRiskGateApprovalHook(this.deps.gate, sessionId));

    // bb-browser 选品站点工具（已启用站点）：同步注册，只挂 handler 不 spawn（执行时才 spawn），不会失败。
    try {
      registerBbSites(toolHost, req.enabledSites);
    } catch (err) {
      console.error("[agent-service] register bb sites failed", err);
    }

    // MCP 挂载：graceful——失败不再让整个会话失败（发起人反馈：bb-browser 挂载失败曾导致
    // start-session 整体崩）。失败信息收集后作为 agent_error 推回，会话照常可用（纯对话 +
    // 已注册的站点工具仍然工作）。
    const mounts: McpMountHandle[] = [];
    const mcpErrors: string[] = [];
    for (const config of req.mcpServers) {
      try {
        mounts.push(await this.mountMcp(toolHost, toMcpConfig(config)));
      } catch (err) {
        mcpErrors.push(
          `MCP server「${config.name}」挂载失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const backend = this.createBackend(profile, this.deps.credentials);
    const handle = this.createSession({
      sessionId,
      backend,
      toolHost,
      systemPrompt: req.systemPrompt,
      maxSteps: req.maxSteps,
      budgetUsd: req.budgetUsd,
      model: profile.model,
      pricing: profile.pricing,
    });

    const session: ActiveSession = {
      handle,
      mounts,
      sink,
      seq: 0,
      ended: false,
      unsubscribe: () => {},
    };
    session.unsubscribe = handle.onEvent((event) => this.dispatch(session, sessionId, event));
    this.sessions.set(sessionId, session);

    // MCP 挂载失败作为可恢复错误推回（会话已建立可用，不阻断）
    for (const msg of mcpErrors) {
      this.dispatch(session, sessionId, {
        type: "agent_error",
        sessionId,
        message: msg,
        recoverable: true,
      });
    }
    return sessionId;
  }

  // fire-and-forget：loop 一轮可能跑很久，IPC handler 不 await；
  // 状态错误（并发 send / 会话已结束）转成 agent_error 事件推回 renderer。
  send(sessionId: string, message: string): void {
    const session = this.mustGet(sessionId);
    session.handle.send(message).catch((err) => {
      this.dispatch(session, sessionId, {
        type: "agent_error",
        sessionId,
        message: err instanceof Error ? err.message : String(err),
        recoverable: true,
      });
    });
  }

  abort(sessionId: string): void {
    this.mustGet(sessionId).handle.abort();
  }

  // 退出/窗口关闭时清理：中止所有会话 + 卸载 MCP 子进程
  async disposeAll(): Promise<void> {
    const all = [...this.sessions.entries()];
    this.sessions.clear();
    for (const [, session] of all) {
      session.unsubscribe();
      try {
        session.handle.abort();
      } catch (err) {
        console.error("[agent-service] abort on dispose failed", err);
      }
      await closeMounts(session.mounts);
    }
  }

  // ----- internal -----

  // 事件分发：先落库（持久化回放），再推 renderer；落库失败不阻断推送
  private dispatch(session: ActiveSession, sessionId: string, event: AgentEvent): void {
    try {
      this.deps.agentEvents.append({
        sessionId,
        seq: session.seq++,
        type: event.type,
        payload: event,
      });
    } catch (err) {
      console.error("[agent-service] agent_events append failed", err);
    }
    try {
      session.sink.send(event);
    } catch (err) {
      console.error("[agent-service] event sink send failed", err);
    }

    // 会话终结（success 之外的 result 都是终态，见 agent-core session.ts）：
    // 卸载 MCP 子进程并移出 Map，不留孤儿子进程
    if (event.type === "agent_session_result" && event.subtype !== "success" && !session.ended) {
      session.ended = true;
      session.unsubscribe();
      this.sessions.delete(sessionId);
      void closeMounts(session.mounts);
    }
  }

  private mustGet(sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`unknown agent session: ${sessionId}`);
    }
    return session;
  }
}

function toMcpConfig(config: AgentMcpServerConfig): McpServerConfig {
  return {
    name: config.name,
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
  };
}

async function closeMounts(mounts: McpMountHandle[]): Promise<void> {
  for (const mount of mounts) {
    try {
      await mount.close();
    } catch (err) {
      console.error(`[agent-service] mcp server close failed: ${mount.serverName}`, err);
    }
  }
}
