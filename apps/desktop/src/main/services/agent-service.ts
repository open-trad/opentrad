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
import { isAbsolute } from "node:path";
import { type AgentSessionHandle, createAgentSession } from "@opentrad/agent-core";
import { registerBbSites } from "@opentrad/connectors";
import {
  ApiKeyBackend,
  type ChatBackend,
  type CredentialStore,
  ProfileRegistry,
  type ProviderProfile,
  ProviderProfileSchema,
} from "@opentrad/model-providers";
import type { DecisionKind, RiskGate } from "@opentrad/risk-gate";
import type {
  RuntimeAdapter,
  RuntimeApprovalChoice,
  RuntimeBinding,
  RuntimeEvent,
  RuntimeResumeInput,
} from "@opentrad/runtime-adapter";
import type {
  AgentEvent,
  AgentMcpServerConfig,
  AgentProfileCredential,
  AgentSessionMeta,
  AgentSessionOpenResponse,
  AgentSessionStatus,
  AgentStartSessionRequest,
  AgentUserEvent,
} from "@opentrad/shared";
import {
  type McpMountHandle,
  type McpServerConfig,
  mountMcpServer,
  type ToolApprovalHook,
  ToolHost,
} from "@opentrad/tool-host";
import type {
  AgentEventService,
  AgentRuntimeBindingRow,
  AgentRuntimeBindingService,
  AgentSessionRow,
  AgentSessionService,
  ProviderProfileService,
} from "./db";
import type { HermesExecutionBackendValidator } from "./hermes/docker-preflight";
import { createHermesEventMapper, type HermesEventMapper } from "./hermes/event-mapper";
import { isSupportedHermesOAuthProfile } from "./hermes/oauth-login";
import {
  type HermesProfileHomeDeleter,
  type HermesProfileHomeQuarantine,
  profileHomeAuthorityHash,
} from "./hermes/profile-home";
import type { HermesInteractionPromptService } from "./hermes-interaction-prompter";

const UNSUPPORTED_HERMES_OAUTH_PROFILE = "Hermes OAuth Profile is unsupported";
const UNSUPPORTED_HERMES_API_KEY_PROFILE = "Hermes API-key Profile is unsupported";
const MAX_PROVIDER_BASE_URL_LENGTH = 2_048;

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

export function mapRiskGateDecisionToHermesApproval(decision: DecisionKind): RuntimeApprovalChoice {
  switch (decision) {
    case "allow":
    case "allow_once":
      return "once";
    case "allow_session":
      return "session";
    case "allow_always":
      return "always";
    case "deny":
      return "deny";
  }
}

interface LegacyActiveSession {
  kind: "legacy";
  handle: AgentSessionHandle;
  mounts: McpMountHandle[];
  sink: AgentEventSink;
  unsubscribe: () => void;
  seq: number;
  ended: boolean;
}

interface NativeActiveSession {
  kind: "hermes";
  binding: RuntimeBinding;
  profile: ProviderProfile;
  workspaceRoot: string;
  mapper: HermesEventMapper;
  knownSecrets: string[];
  sink: AgentEventSink;
  seq: number;
  streaming: boolean;
  interruptRequested: boolean;
  revoked: boolean;
}

type ActiveSession = LegacyActiveSession | NativeActiveSession;

export interface AgentServiceDeps {
  profiles: ProviderProfileService;
  agentEvents: AgentEventService;
  agentSessions: AgentSessionService;
  agentRuntimeBindings?: AgentRuntimeBindingService;
  credentials: CredentialStore;
  gate: RiskGate;
  runtime?: RuntimeAdapter;
  validateWorkspaceRoot?: (workspaceRoot: string) => Promise<string>;
  validateExecutionBackend?: HermesExecutionBackendValidator;
  hermesInteractionPrompter?: HermesInteractionPromptService;
  deleteProfileHome?: HermesProfileHomeDeleter;
  initiallyBlockedProfileIds?: readonly string[];
  invalidateOAuthProfile?: (profileId: string) => Promise<void>;
}

// 工厂注入口：单测替换（fake backend / fake session / fake mcp 连接），生产走默认实现
export interface AgentServiceFactories {
  createBackend?: (profile: ProviderProfile, credentials: CredentialStore) => ChatBackend;
  createSession?: typeof createAgentSession;
  mountMcp?: (host: ToolHost, config: McpServerConfig) => Promise<McpMountHandle>;
  createHermesEventMapper?: typeof createHermesEventMapper;
}

export class AgentService {
  private readonly registry = new ProfileRegistry();
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly createBackend: NonNullable<AgentServiceFactories["createBackend"]>;
  private readonly createSession: typeof createAgentSession;
  private readonly mountMcp: NonNullable<AgentServiceFactories["mountMcp"]>;
  private readonly createHermesMapper: typeof createHermesEventMapper;
  private readonly recoveries = new Map<string, Promise<void>>();
  private readonly profileMutations = new Map<string, Promise<unknown>>();
  private readonly credentialMutations = new Map<string, Promise<unknown>>();
  private readonly profileRuntimeOperations = new Map<string, Set<Promise<unknown>>>();
  private readonly blockedProfiles = new Set<string>();
  private readonly pendingNativeSessionIds = new Set<string>();
  private disposed = false;

  constructor(
    private readonly deps: AgentServiceDeps,
    factories: AgentServiceFactories = {},
  ) {
    this.createBackend =
      factories.createBackend ??
      ((profile, credentials) => new ApiKeyBackend(profile, credentials));
    this.createSession = factories.createSession ?? createAgentSession;
    this.mountMcp = factories.mountMcp ?? ((host, config) => mountMcpServer(host, config));
    this.createHermesMapper = factories.createHermesEventMapper ?? createHermesEventMapper;
    for (const profileId of this.deps.initiallyBlockedProfileIds ?? []) {
      if (typeof profileId === "string" && profileId.length > 0) {
        this.blockedProfiles.add(profileId);
      }
    }

    // 启动时从 SQLite 回灌 registry；单行校验失败跳过（脏数据保护）
    for (const raw of this.deps.profiles.listRaw()) {
      try {
        const candidate = new ProfileRegistry().register(raw);
        this.assertPersistedCredentialOwnership(candidate);
        this.registry.register(candidate);
      } catch {
        console.error("[agent-service] skipping invalid persisted profile");
      }
    }
  }

  // ----- profiles -----

  listProfiles(): ProviderProfile[] {
    return this.registry.list();
  }

  isProfileAvailableForOAuth(profileId: string): boolean {
    if (
      this.disposed ||
      this.blockedProfiles.has(profileId) ||
      this.profileMutations.has(profileId)
    ) {
      return false;
    }
    const profile = this.registry.get(profileId);
    return Boolean(profile && isSupportedHermesOAuthProfile(profile));
  }

  // Profile metadata、可选凭证与 runtime 失效共享同一个 per-profile mutation 边界。
  saveProfile(raw: unknown, credential?: AgentProfileCredential): Promise<ProviderProfile> {
    const candidate = new ProfileRegistry().register(raw);
    try {
      this.assertProfileTrustBoundary(candidate);
    } catch {
      return Promise.reject(new Error(profileTrustBoundaryErrorMessage(candidate)));
    }
    try {
      this.assertCredentialPolicy(candidate, this.registry.get(candidate.id), credential);
    } catch {
      return Promise.reject(new Error("provider Profile credential policy rejected"));
    }
    return this.runProfileMutation(candidate.id, () => {
      this.assertNotDisposed();
      const save = (): ProviderProfile | Promise<ProviderProfile> => {
        const existing = this.registry.get(candidate.id);
        this.assertProfileTrustBoundary(candidate);
        this.assertCredentialPolicy(candidate, existing, credential);
        const invalidation = this.prepareProfileInvalidation(existing);
        const commitAfterInvalidation = (): ProviderProfile | Promise<ProviderProfile> => {
          this.assertNotDisposed();
          const homeDeletion = this.prepareProfileHomeDeletionForSave(existing, candidate);
          if (isPromiseLike(homeDeletion)) {
            return homeDeletion.then((quarantine) => {
              this.assertNotDisposed();
              return this.commitProfileSave(candidate, existing, credential, quarantine);
            });
          }
          return this.commitProfileSave(candidate, existing, credential);
        };
        if (isPromiseLike(invalidation)) {
          return invalidation.then(commitAfterInvalidation);
        }
        return commitAfterInvalidation();
      };
      return candidate.credentialRef
        ? this.runCredentialMutation(candidate.credentialRef, save)
        : save();
    });
  }

  deleteProfile(id: string): Promise<void> {
    return this.runProfileMutation(id, () => {
      this.assertNotDisposed();
      const existing = this.registry.get(id);
      const remove = (): void | Promise<void> => {
        const invalidation = this.prepareProfileInvalidation(existing);
        const commitAfterInvalidation = (): void | Promise<void> => {
          this.assertNotDisposed();
          const homeDeletion = this.prepareProfileHomeDeletion(existing, null);
          if (isPromiseLike(homeDeletion)) {
            return homeDeletion.then((quarantine) => {
              this.assertNotDisposed();
              return this.commitProfileDelete(id, existing, quarantine);
            });
          }
          return this.commitProfileDelete(id, existing);
        };
        if (isPromiseLike(invalidation)) {
          return invalidation.then(commitAfterInvalidation);
        }
        return commitAfterInvalidation();
      };
      return existing?.credentialRef
        ? this.runCredentialMutation(existing.credentialRef, remove)
        : remove();
    });
  }

  private assertPersistedCredentialOwnership(candidate: ProviderProfile): void {
    this.assertProfileTrustBoundary(candidate);
    if (candidate.hermes.authMode === "oauth") {
      if (candidate.credentialRef) throw new Error();
      return;
    }
    if (!candidate.credentialRef) throw new Error();
    this.assertCredentialRefHasNoOtherOwner(candidate);
  }

  private assertCredentialPolicy(
    candidate: ProviderProfile,
    existing: ProviderProfile | undefined,
    credential: AgentProfileCredential | undefined,
  ): void {
    if (candidate.hermes.authMode === "oauth") {
      if (candidate.credentialRef || credential) throw new Error();
      return;
    }

    const credentialRef = candidate.credentialRef;
    if (!credentialRef || (credential && credential.ref !== credentialRef)) throw new Error();
    this.assertCredentialRefHasNoOtherOwner(candidate);

    const changesCredentialAuthority =
      !existing ||
      existing.hermes.authMode !== "api_key" ||
      existing.credentialRef !== credentialRef ||
      existing.kind !== candidate.kind ||
      existing.baseUrl !== candidate.baseUrl ||
      existing.hermes.providerSlug !== candidate.hermes.providerSlug ||
      existing.hermes.apiMode !== candidate.hermes.apiMode;
    if (changesCredentialAuthority && !credential) throw new Error();
  }

  private assertCredentialRefHasNoOtherOwner(candidate: ProviderProfile): void {
    if (
      this.registry
        .list()
        .some(
          (profile) =>
            profile.id !== candidate.id && profile.credentialRef === candidate.credentialRef,
        )
    ) {
      throw new Error();
    }
  }

  private assertProfileTrustBoundary(profile: ProviderProfile): void {
    if (profile.hermes.authMode === "oauth") {
      if (!isSupportedHermesOAuthProfile(profile)) {
        throw new Error(UNSUPPORTED_HERMES_OAUTH_PROFILE);
      }
      return;
    }
    if (!isCanonicalApiKeyProfile(profile)) {
      throw new Error(UNSUPPORTED_HERMES_API_KEY_PROFILE);
    }
  }

  private isProfileTrustBoundarySupported(profile: ProviderProfile): boolean {
    try {
      this.assertProfileTrustBoundary(profile);
      return true;
    } catch {
      return false;
    }
  }

  private prepareProfileInvalidation(
    existing: ProviderProfile | undefined,
  ): undefined | Promise<void> {
    if (!existing) return;
    const invalidateRuntime = (): undefined | Promise<void> => {
      if (this.deps.runtime?.kind === "hermes") {
        return this.invalidateHermesProfile(existing.id);
      }
      try {
        this.deps.agentRuntimeBindings?.invalidateProfile(existing.id, Date.now());
      } catch {
        throw new Error("provider Profile invalidation failed");
      }
    };
    const invalidateOAuthProfile = this.deps.invalidateOAuthProfile;
    if (!invalidateOAuthProfile) return invalidateRuntime();
    let oauthInvalidation: Promise<void>;
    try {
      oauthInvalidation = invalidateOAuthProfile(existing.id);
    } catch {
      throw new Error("provider Profile invalidation failed");
    }
    return Promise.resolve(oauthInvalidation).then(invalidateRuntime, () => {
      throw new Error("provider Profile invalidation failed");
    });
  }

  private prepareProfileHomeDeletionForSave(
    existing: ProviderProfile | undefined,
    candidate: ProviderProfile,
  ): undefined | Promise<HermesProfileHomeQuarantine> {
    if (!existing || !profileHomeAuthorityChanged(existing, candidate)) return;
    return this.prepareProfileHomeDeletion(existing, profileHomeAuthorityHash(candidate));
  }

  private prepareProfileHomeDeletion(
    existing: ProviderProfile | undefined,
    newAuthorityHash: string | null,
  ): undefined | Promise<HermesProfileHomeQuarantine> {
    if (!existing) return;
    const deleteProfileHome = this.deps.deleteProfileHome;
    if (!deleteProfileHome) {
      if (this.deps.runtime?.kind === "hermes") {
        throw new Error("provider Profile Home deletion failed");
      }
      return;
    }
    return deleteProfileHome(existing.id, {
      oldAuthorityHash: profileHomeAuthorityHash(existing),
      newAuthorityHash,
    }).catch(() => {
      throw new Error("provider Profile Home deletion failed");
    });
  }

  private commitProfileSave(
    candidate: ProviderProfile,
    existing: ProviderProfile | undefined,
    credential: AgentProfileCredential | undefined,
    quarantine?: HermesProfileHomeQuarantine,
  ): ProviderProfile | Promise<ProviderProfile> {
    this.assertNotDisposed();
    const retiredCredentialRef = this.retiredCredentialRef(existing, candidate);
    if (credential) {
      return this.commitProfileSaveWithCredential(
        candidate,
        existing,
        credential,
        retiredCredentialRef,
        quarantine,
      );
    }
    if (retiredCredentialRef) {
      return this.commitProfileSaveRetiringCredential(
        candidate,
        existing,
        retiredCredentialRef,
        quarantine,
      );
    }
    if (quarantine) {
      return this.commitProfileSaveWithQuarantine(candidate, existing, quarantine);
    }
    try {
      this.deps.profiles.save(candidate.id, candidate);
    } catch {
      this.restorePersistedProfile(candidate.id, existing);
      throw new Error("provider Profile save failed");
    }
    return this.registry.register(candidate);
  }

  private async commitProfileSaveWithQuarantine(
    candidate: ProviderProfile,
    existing: ProviderProfile | undefined,
    quarantine: HermesProfileHomeQuarantine,
  ): Promise<ProviderProfile> {
    let profileWriteAttempted = false;
    try {
      profileWriteAttempted = true;
      this.deps.profiles.save(candidate.id, candidate);
      await quarantine.finalize();
    } catch {
      const compensated =
        !profileWriteAttempted || this.restorePersistedProfile(candidate.id, existing);
      if (compensated) await this.rollbackProfileHome(quarantine);
      throw new Error("provider Profile save failed");
    }
    return this.registry.register(candidate);
  }

  private async commitProfileSaveWithCredential(
    candidate: ProviderProfile,
    existing: ProviderProfile | undefined,
    credential: AgentProfileCredential,
    retiredCredentialRef: string | undefined,
    quarantine?: HermesProfileHomeQuarantine,
  ): Promise<ProviderProfile> {
    let previousSecret: string | null;
    let previousRetiredSecret: string | null = null;
    try {
      previousSecret = await this.deps.credentials.get(credential.ref);
      if (retiredCredentialRef) {
        previousRetiredSecret = await this.deps.credentials.get(retiredCredentialRef);
      }
      this.assertNotDisposed();
    } catch {
      if (quarantine) await this.rollbackProfileHome(quarantine);
      if (this.disposed) throw new Error("agent service is disposed");
      throw new Error("provider Profile save failed");
    }

    let credentialWriteAttempted = false;
    let retiredCredentialDeleteAttempted = false;
    let profileWriteAttempted = false;
    try {
      credentialWriteAttempted = true;
      await this.deps.credentials.set(credential.ref, credential.secret);
      this.assertNotDisposed();
      profileWriteAttempted = true;
      this.deps.profiles.save(candidate.id, candidate);
      if (retiredCredentialRef) {
        retiredCredentialDeleteAttempted = true;
        await this.deps.credentials.delete(retiredCredentialRef);
      }
      if (quarantine) await quarantine.finalize();
    } catch {
      let compensated = true;
      if (profileWriteAttempted) {
        compensated = this.restorePersistedProfile(candidate.id, existing) && compensated;
      }
      if (credentialWriteAttempted) {
        compensated = (await this.restoreCredential(credential.ref, previousSecret)) && compensated;
      }
      if (retiredCredentialRef && retiredCredentialDeleteAttempted) {
        compensated =
          (await this.restoreCredential(retiredCredentialRef, previousRetiredSecret)) &&
          compensated;
      }
      if (quarantine && compensated) await this.rollbackProfileHome(quarantine);
      if (this.disposed) throw new Error("agent service is disposed");
      throw new Error("provider Profile save failed");
    }
    return this.registry.register(candidate);
  }

  private async commitProfileSaveRetiringCredential(
    candidate: ProviderProfile,
    existing: ProviderProfile | undefined,
    retiredCredentialRef: string,
    quarantine?: HermesProfileHomeQuarantine,
  ): Promise<ProviderProfile> {
    let previousSecret: string | null;
    try {
      previousSecret = await this.deps.credentials.get(retiredCredentialRef);
      this.assertNotDisposed();
    } catch {
      if (quarantine) await this.rollbackProfileHome(quarantine);
      if (this.disposed) throw new Error("agent service is disposed");
      throw new Error("provider Profile save failed");
    }

    let profileWriteAttempted = false;
    let credentialDeleteAttempted = false;
    try {
      profileWriteAttempted = true;
      this.deps.profiles.save(candidate.id, candidate);
      credentialDeleteAttempted = true;
      await this.deps.credentials.delete(retiredCredentialRef);
      if (quarantine) await quarantine.finalize();
    } catch {
      let compensated = true;
      if (profileWriteAttempted) {
        compensated = this.restorePersistedProfile(candidate.id, existing) && compensated;
      }
      if (credentialDeleteAttempted) {
        compensated =
          (await this.restoreCredential(retiredCredentialRef, previousSecret)) && compensated;
      }
      if (quarantine && compensated) await this.rollbackProfileHome(quarantine);
      if (this.disposed) throw new Error("agent service is disposed");
      throw new Error("provider Profile save failed");
    }
    return this.registry.register(candidate);
  }

  private retiredCredentialRef(
    existing: ProviderProfile | undefined,
    candidate: ProviderProfile,
  ): string | undefined {
    const credentialRef = existing?.credentialRef;
    if (!credentialRef || credentialRef === candidate.credentialRef) return undefined;
    return this.registry
      .list()
      .some((profile) => profile.id !== existing.id && profile.credentialRef === credentialRef)
      ? undefined
      : credentialRef;
  }

  private commitProfileDelete(
    id: string,
    existing: ProviderProfile | undefined,
    quarantine?: HermesProfileHomeQuarantine,
  ): void | Promise<void> {
    this.assertNotDisposed();
    const credentialRef = existing?.credentialRef;
    const sharedCredential = credentialRef
      ? this.registry
          .list()
          .some((profile) => profile.id !== id && profile.credentialRef === credentialRef)
      : false;
    if (credentialRef && !sharedCredential) {
      return this.commitProfileDeleteWithCredential(id, existing, credentialRef, quarantine);
    }
    if (quarantine) {
      return this.commitProfileDeleteWithQuarantine(id, existing, quarantine);
    }
    try {
      this.deps.profiles.delete(id);
    } catch {
      this.restorePersistedProfile(id, existing);
      throw new Error("provider Profile delete failed");
    }
    this.registry.remove(id);
  }

  private async commitProfileDeleteWithQuarantine(
    id: string,
    existing: ProviderProfile | undefined,
    quarantine: HermesProfileHomeQuarantine,
  ): Promise<void> {
    let profileWriteAttempted = false;
    try {
      profileWriteAttempted = true;
      this.deps.profiles.delete(id);
      await quarantine.finalize();
    } catch {
      const compensated = !profileWriteAttempted || this.restorePersistedProfile(id, existing);
      if (compensated) await this.rollbackProfileHome(quarantine);
      throw new Error("provider Profile delete failed");
    }
    this.registry.remove(id);
  }

  private async commitProfileDeleteWithCredential(
    id: string,
    existing: ProviderProfile,
    credentialRef: string,
    quarantine?: HermesProfileHomeQuarantine,
  ): Promise<void> {
    let previousSecret: string | null;
    try {
      previousSecret = await this.deps.credentials.get(credentialRef);
      this.assertNotDisposed();
    } catch {
      if (quarantine) await this.rollbackProfileHome(quarantine);
      if (this.disposed) throw new Error("agent service is disposed");
      throw new Error("provider Profile delete failed");
    }

    let credentialDeleteAttempted = false;
    try {
      this.deps.profiles.delete(id);
      credentialDeleteAttempted = true;
      await this.deps.credentials.delete(credentialRef);
      this.assertNotDisposed();
      if (quarantine) await quarantine.finalize();
    } catch {
      let compensated = this.restorePersistedProfile(id, existing);
      if (credentialDeleteAttempted) {
        compensated = (await this.restoreCredential(credentialRef, previousSecret)) && compensated;
      }
      if (quarantine && compensated) await this.rollbackProfileHome(quarantine);
      if (this.disposed) throw new Error("agent service is disposed");
      throw new Error("provider Profile delete failed");
    }
    this.registry.remove(id);
  }

  private async rollbackProfileHome(quarantine: HermesProfileHomeQuarantine): Promise<void> {
    try {
      await quarantine.rollback();
    } catch {
      // The Profile remains blocked and recovery uses the durable quarantine marker at restart.
    }
  }

  private restorePersistedProfile(id: string, previous: ProviderProfile | undefined): boolean {
    try {
      if (previous) this.deps.profiles.save(id, previous);
      else this.deps.profiles.delete(id);
      return true;
    } catch {
      // The in-memory Profile remains blocked. Never surface storage details to renderer.
      return false;
    }
  }

  private async restoreCredential(ref: string, previous: string | null): Promise<boolean> {
    try {
      if (previous === null) await this.deps.credentials.delete(ref);
      else await this.deps.credentials.set(ref, previous);
      return true;
    } catch {
      // The Profile remains blocked until an explicit retry completes the mutation.
      return false;
    }
  }

  respondHermesInteraction(raw: unknown, sourceId: number): boolean {
    return this.deps.hermesInteractionPrompter?.handleResponse(raw, sourceId) ?? false;
  }

  // ----- 会话历史（侧栏「任务」）-----

  listSessions(): AgentSessionMeta[] {
    return this.deps.agentSessions.list().map(toAgentSessionMeta);
  }

  isSessionResumable(sessionId: string): boolean {
    return this.deps.agentRuntimeBindings?.get(sessionId)?.resumable === true;
  }

  // 回放：返回该会话的全部事件 payload（含 agent_user 用户消息），renderer 重建 items
  loadSessionEvents(sessionId: string): unknown[] {
    return this.deps.agentEvents.readBySession(sessionId).map((row) => {
      try {
        return JSON.parse(row.payload);
      } catch {
        return { type: "unknown", raw: row.payload };
      }
    });
  }

  async openSession(sessionId: string, sink: AgentEventSink): Promise<AgentSessionOpenResponse> {
    const sessionRow = this.deps.agentSessions.get(sessionId);
    if (!sessionRow) throw new Error(`unknown agent session: ${sessionId}`);
    const session = toAgentSessionMeta(sessionRow);
    const events = this.loadSessionEvents(sessionId);
    const active = this.sessions.get(sessionId);
    if (active) {
      if (
        active.kind !== "hermes" ||
        (!this.profileMutations.has(active.profile.id) &&
          !this.blockedProfiles.has(active.profile.id))
      ) {
        active.sink = sink;
        return { session, events, recovery: "live" };
      }
      active.revoked = true;
      this.sessions.delete(sessionId);
    }

    const bindings = this.deps.agentRuntimeBindings;
    const binding = bindings?.get(sessionId);
    const runtime = this.deps.runtime;
    const profile = binding ? this.registry.get(binding.profileId) : undefined;
    if (
      !bindings ||
      !binding?.resumable ||
      !binding.durableSessionId ||
      runtime?.kind !== "hermes" ||
      !profile ||
      !this.isProfileTrustBoundarySupported(profile) ||
      this.profileMutations.has(profile.id) ||
      this.blockedProfiles.has(profile.id) ||
      this.disposed
    ) {
      return { session, events, recovery: "read_only" };
    }

    if (!this.recoveries.has(sessionId)) {
      const resuming = this.updateBindingStatus(sessionId, "resuming", true);
      if (!resuming) return { session, events, recovery: "read_only" };
      const recovery = this.trackProfileRuntimeOperation(
        profile.id,
        this.resumeNative(binding, profile, sink),
      );
      this.recoveries.set(sessionId, recovery);
      void recovery.finally(() => {
        if (this.recoveries.get(sessionId) === recovery) this.recoveries.delete(sessionId);
      });
    }
    const updatedSession = this.deps.agentSessions.get(sessionId);
    return {
      session: updatedSession ? toAgentSessionMeta(updatedSession) : session,
      events,
      recovery: "resuming",
    };
  }

  // ----- sessions -----

  async startSession(req: AgentStartSessionRequest, sink: AgentEventSink): Promise<string> {
    if (this.disposed) throw new Error("agent service is disposed");
    if (this.profileMutations.has(req.profileId) || this.blockedProfiles.has(req.profileId)) {
      throw new Error(`provider profile is unavailable while cleanup is pending: ${req.profileId}`);
    }
    const profile = this.registry.get(req.profileId);
    if (!profile) {
      throw new Error(`unknown provider profile: ${req.profileId}`);
    }
    this.assertProfileTrustBoundary(profile);
    if (this.deps.runtime?.kind === "hermes") {
      return this.trackProfileRuntimeOperation(
        profile.id,
        this.startNativeSession(req, profile, sink),
      );
    }
    return this.startLegacySession(req, profile, sink);
  }

  private async startLegacySession(
    req: AgentStartSessionRequest,
    profile: ProviderProfile,
    sink: AgentEventSink,
  ): Promise<string> {
    const sessionId = randomUUID();
    const toolHost = new ToolHost(createRiskGateApprovalHook(this.deps.gate, sessionId));

    // bb-browser 选品站点工具（已启用站点）：同步注册，只挂 handler 不 spawn（执行时才 spawn），不会失败。
    try {
      registerBbSites(toolHost, req.enabledSites ?? []);
    } catch (err) {
      console.error("[agent-service] register bb sites failed", err);
    }

    // MCP 挂载：graceful——失败不再让整个会话失败（发起人反馈：bb-browser 挂载失败曾导致
    // start-session 整体崩）。失败信息收集后作为 agent_error 推回，会话照常可用（纯对话 +
    // 已注册的站点工具仍然工作）。
    const mounts: McpMountHandle[] = [];
    const mcpErrors: string[] = [];
    for (const config of req.mcpServers ?? []) {
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

    const session: LegacyActiveSession = {
      kind: "legacy",
      handle,
      mounts,
      sink,
      seq: 0,
      ended: false,
      unsubscribe: () => {},
    };
    session.unsubscribe = handle.onEvent((event) => this.dispatch(session, sessionId, event));
    this.sessions.set(sessionId, session);

    // 会话历史元数据（侧栏「任务」列表）：标题在首条用户消息时补
    try {
      this.deps.agentSessions.create(sessionId, profile.model, Date.now());
    } catch (err) {
      console.error("[agent-service] agent_sessions create failed", err);
    }

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

  private async startNativeSession(
    req: AgentStartSessionRequest,
    profile: ProviderProfile,
    sink: AgentEventSink,
  ): Promise<string> {
    const runtime = this.requireNativeRuntime();
    const bindings = this.requireRuntimeBindings();
    const validateWorkspaceRoot = this.deps.validateWorkspaceRoot;
    if (!validateWorkspaceRoot) {
      throw new Error("Hermes workspace validation is unavailable");
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await validateWorkspaceRoot(req.workspaceRoot);
    } catch {
      throw new Error("Hermes workspace validation failed");
    }
    this.assertNotDisposed();
    if (
      typeof workspaceRoot !== "string" ||
      workspaceRoot.length === 0 ||
      workspaceRoot.includes("\0") ||
      !isAbsolute(workspaceRoot)
    ) {
      throw new Error("Hermes workspace validation failed");
    }

    const validateExecutionBackend = this.deps.validateExecutionBackend;
    if (profile.hermes.executionBackend === "docker" && !validateExecutionBackend) {
      throw new Error("Hermes execution backend validation is unavailable");
    }
    if (validateExecutionBackend) {
      try {
        await validateExecutionBackend(profile, workspaceRoot);
      } catch {
        throw new Error("Hermes execution backend validation failed");
      }
      this.assertNotDisposed();
    }
    this.assertProfileCurrent(profile);

    const sessionId = randomUUID();
    const createdAt = Date.now();
    try {
      this.deps.agentSessions.create(sessionId, profile.model, createdAt);
      bindings.create({
        sessionId,
        profileId: profile.id,
        workspaceRoot,
        status: "creating",
        createdAt,
      });
      this.pendingNativeSessionIds.add(sessionId);
    } catch {
      bindings.delete(sessionId);
      this.deps.agentSessions.delete(sessionId);
      throw new Error("Hermes session persistence failed");
    }

    let binding: RuntimeBinding | undefined;
    try {
      const knownSecrets = await this.loadKnownSecrets(profile);
      this.assertNotDisposed();
      this.assertProfileCurrent(profile);
      const mapper = this.createHermesMapper({
        canonicalSessionId: sessionId,
        profileId: profile.id,
        model: profile.model,
        knownSecrets,
      });
      binding = await runtime.create({
        canonicalSessionId: sessionId,
        taskId: sessionId,
        runId: randomUUID(),
        workspaceRoot,
        provider: {
          profileId: profile.id,
          providerSlug: profile.hermes.providerSlug,
          authMode: profile.hermes.authMode,
          model: profile.model,
          apiMode: profile.hermes.apiMode,
          executionBackend: profile.hermes.executionBackend,
        },
      });
      this.assertNotDisposed();
      this.assertProfileCurrent(profile);
      if (
        binding.canonicalSessionId !== sessionId ||
        !binding.durableRuntimeSessionId ||
        !bindings.attachDurableSession({
          sessionId,
          durableSessionId: binding.durableRuntimeSessionId,
          status: "idle",
          resumable: true,
          updatedAt: Date.now(),
        })
      ) {
        throw new Error("invalid Hermes durable binding");
      }

      this.pendingNativeSessionIds.delete(sessionId);
      this.sessions.set(sessionId, {
        kind: "hermes",
        binding,
        profile,
        workspaceRoot,
        mapper,
        knownSecrets: [...knownSecrets],
        sink,
        seq: this.nextEventSeq(sessionId),
        streaming: false,
        interruptRequested: false,
        revoked: false,
      });
      return sessionId;
    } catch {
      if (binding) {
        try {
          await runtime.close(binding);
        } catch {
          // Creation already failed. Cleanup errors must not replace the fixed public failure.
        }
      }
      this.pendingNativeSessionIds.delete(sessionId);
      if (this.disposed) throw new Error("agent service is disposed");
      this.updateBindingStatus(sessionId, "error", false);
      this.persistEvent(
        sessionId,
        this.nextEventSeq(sessionId),
        nativeErrorEvent(sessionId, "Hermes session creation failed", false),
      );
      throw new Error("Hermes session creation failed");
    }
  }

  // fire-and-forget：loop 一轮可能跑很久，IPC handler 不 await。Hermes 并发 send 在
  // 持久化用户消息前同步拒绝，供 renderer 撤回乐观 UI；legacy 的异步错误仍走 agent_error。
  send(sessionId: string, message: string): void {
    const session = this.mustGet(sessionId);
    if (session.kind === "hermes" && session.streaming) {
      throw new Error("Hermes session is already streaming");
    }
    // 持久化用户消息（历史回放要用；AgentEvent 流不含用户输入）+ 首条设为会话标题
    const userEvent: AgentUserEvent = { type: "agent_user", sessionId, text: message };
    this.persistEvent(sessionId, session.seq++, userEvent);
    try {
      this.deps.agentSessions.setTitleIfEmpty(sessionId, message.slice(0, 60));
    } catch {
      console.error("[agent-service] persist user message title failed");
    }

    if (session.kind === "hermes") {
      void this.sendNative(sessionId, session, message);
      return;
    }
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
    const session = this.mustGet(sessionId);
    if (session.kind === "legacy") {
      session.handle.abort();
      return;
    }
    const runtime = this.requireNativeRuntime();
    const wasStreaming = session.streaming;
    session.interruptRequested = true;
    this.updateBindingStatus(sessionId, "interrupted", true);
    void runtime
      .interrupt(session.binding)
      .then(() => {
        if (this.disposed || session.revoked || this.sessions.get(sessionId) !== session) return;
        if (!wasStreaming) {
          this.dispatchNative(
            session,
            nativeResultEvent(sessionId, "aborted", 0, "Hermes session interrupted"),
          );
        }
      })
      .catch(() => {
        if (this.disposed || session.revoked || this.sessions.get(sessionId) !== session) return;
        this.updateBindingStatus(sessionId, "error", true);
        this.dispatchNative(
          session,
          nativeErrorEvent(sessionId, "Hermes session interrupt failed", true),
        );
      });
  }

  // 退出/窗口关闭时清理：中止所有会话 + 卸载 MCP 子进程
  async disposeAll(): Promise<void> {
    for (const sessionId of this.pendingNativeSessionIds) {
      try {
        this.deps.agentRuntimeBindings?.delete(sessionId);
        this.deps.agentSessions.delete(sessionId);
      } catch {
        console.error("[agent-service] pending Hermes session cleanup failed");
      }
    }
    this.disposed = true;
    this.deps.hermesInteractionPrompter?.cleanupAll();
    await this.drainInFlightOperations();
    const all = [...this.sessions.entries()];
    this.sessions.clear();
    for (const [, session] of all) {
      if (session.kind === "hermes") {
        for (const event of session.mapper.finalize()) this.dispatchNative(session, event);
        try {
          await this.requireNativeRuntime().close(session.binding);
        } catch {
          console.error("[agent-service] Hermes session close failed");
        }
        continue;
      }
      session.unsubscribe();
      try {
        session.handle.abort();
      } catch (err) {
        console.error("[agent-service] abort on dispose failed", err);
      }
      await closeMounts(session.mounts);
    }
    if (this.deps.runtime?.kind === "hermes") {
      await this.deps.runtime.dispose();
    }
  }

  // ----- internal -----

  private async sendNative(
    sessionId: string,
    session: NativeActiveSession,
    message: string,
  ): Promise<void> {
    if (session.streaming) {
      this.dispatchNative(
        session,
        nativeErrorEvent(sessionId, "Hermes session is already streaming", true),
      );
      return;
    }

    const startedAt = Date.now();
    session.streaming = true;
    session.interruptRequested = false;
    this.updateBindingStatus(sessionId, "active", true);
    try {
      await this.requireNativeRuntime().stream(session.binding, message, (runtimeEvent) => {
        this.mapRuntimeEvent(session, runtimeEvent);
      });
      if (session.revoked || this.sessions.get(sessionId) !== session) return;
      for (const event of session.mapper.flush()) this.dispatchNative(session, event);
      if (session.interruptRequested) {
        for (const event of session.mapper.finalize()) this.dispatchNative(session, event);
        this.dispatchNative(
          session,
          nativeResultEvent(
            sessionId,
            "aborted",
            Date.now() - startedAt,
            "Hermes session interrupted",
          ),
        );
        this.updateBindingStatus(sessionId, "interrupted", true);
      } else {
        this.dispatchNative(
          session,
          nativeResultEvent(sessionId, "success", Date.now() - startedAt),
        );
        this.updateBindingStatus(sessionId, "idle", true);
      }
    } catch {
      if (session.revoked || this.sessions.get(sessionId) !== session) return;
      for (const event of session.mapper.finalize()) this.dispatchNative(session, event);
      this.dispatchNative(
        session,
        nativeErrorEvent(sessionId, "Hermes session stream failed", true),
      );
      this.dispatchNative(
        session,
        nativeResultEvent(
          sessionId,
          "error",
          Date.now() - startedAt,
          "Hermes session stream failed",
        ),
      );
      this.updateBindingStatus(sessionId, "error", true);
      this.sessions.delete(sessionId);
      try {
        await this.requireNativeRuntime().close(session.binding);
      } catch {
        console.error("[agent-service] Hermes failed stream cleanup could not be confirmed");
      }
    } finally {
      session.streaming = false;
      session.interruptRequested = false;
    }
  }

  private async resumeNative(
    persisted: AgentRuntimeBindingRow,
    profile: ProviderProfile,
    sink: AgentEventSink,
  ): Promise<void> {
    const runtime = this.requireNativeRuntime();
    this.assertProfileTrustBoundary(profile);
    const durableRuntimeSessionId = persisted.durableSessionId;
    if (!durableRuntimeSessionId) return;
    let liveBinding: RuntimeBinding | undefined;
    try {
      const validateWorkspaceRoot = this.deps.validateWorkspaceRoot;
      if (!validateWorkspaceRoot) throw new Error("workspace validation unavailable");
      const workspaceRoot = await validateWorkspaceRoot(persisted.workspaceRoot);
      this.assertNotDisposed();
      if (workspaceRoot !== persisted.workspaceRoot) {
        throw new Error("persisted workspace identity changed");
      }
      const knownSecrets = await this.loadKnownSecrets(profile);
      this.assertNotDisposed();
      this.assertProfileTrustBoundary(profile);
      this.assertProfileCurrent(profile);
      const input: RuntimeResumeInput = {
        canonicalSessionId: persisted.sessionId,
        taskId: persisted.sessionId,
        runId: randomUUID(),
        workspaceRoot,
        provider: {
          profileId: profile.id,
          providerSlug: profile.hermes.providerSlug,
          authMode: profile.hermes.authMode,
          model: profile.model,
          apiMode: profile.hermes.apiMode,
          executionBackend: profile.hermes.executionBackend,
        },
        durableRuntimeSessionId,
      };
      liveBinding = await runtime.resume(input);
      if (
        this.disposed ||
        this.registry.get(profile.id) !== profile ||
        this.profileMutations.has(profile.id) ||
        liveBinding.canonicalSessionId !== persisted.sessionId ||
        liveBinding.durableRuntimeSessionId !== durableRuntimeSessionId
      ) {
        throw new Error("invalid resumed Hermes binding");
      }
      const mapper = this.createHermesMapper({
        canonicalSessionId: persisted.sessionId,
        profileId: profile.id,
        model: profile.model,
        knownSecrets,
      });
      this.sessions.set(persisted.sessionId, {
        kind: "hermes",
        binding: liveBinding,
        profile,
        workspaceRoot: persisted.workspaceRoot,
        mapper,
        knownSecrets: [...knownSecrets],
        sink,
        seq: this.nextEventSeq(persisted.sessionId),
        streaming: false,
        interruptRequested: false,
        revoked: false,
      });
      if (!this.updateBindingStatus(persisted.sessionId, "idle", true)) {
        this.sessions.delete(persisted.sessionId);
        throw new Error("Hermes binding status changed during resume");
      }
    } catch {
      if (liveBinding) {
        try {
          await runtime.close(liveBinding);
        } catch {
          // Preserve the local read-only history even if runtime cleanup fails.
        }
      }
      if (this.disposed) {
        this.sessions.delete(persisted.sessionId);
        return;
      }
      this.sessions.delete(persisted.sessionId);
      this.updateBindingStatus(
        persisted.sessionId,
        "read_only",
        Boolean(this.registry.get(profile.id)),
      );
      const event = nativeErrorEvent(
        persisted.sessionId,
        "Hermes session resume failed; local history remains available",
        true,
      );
      this.persistEvent(persisted.sessionId, this.nextEventSeq(persisted.sessionId), event);
      try {
        sink.send(event);
      } catch {
        console.error("[agent-service] event sink send failed");
      }
    }
  }

  private mapRuntimeEvent(session: NativeActiveSession, event: RuntimeEvent): void {
    if (session.revoked) return;
    if (isHermesInteractionEvent(event.type)) {
      void this.handleHermesInteraction(session, event);
      return;
    }
    for (const mapped of session.mapper.map(event)) this.dispatchNative(session, mapped);
  }

  private async handleHermesInteraction(
    session: NativeActiveSession,
    event: RuntimeEvent,
  ): Promise<void> {
    const payload = recordOf(event.payload);
    const runtime = this.requireNativeRuntime();
    const prompter = this.deps.hermesInteractionPrompter;

    if (event.type === "approval.request") {
      let choice: RuntimeApprovalChoice = "deny";
      const toolName = optionalDisplayField(
        "value",
        firstString(payload, "tool_name", "tool", "name"),
        session.knownSecrets,
      ).value;
      const pluginName = optionalDisplayField(
        "value",
        firstString(payload, "plugin_name", "plugin"),
        session.knownSecrets,
      ).value;
      const skillId = optionalDisplayField(
        "value",
        firstString(payload, "skill_id", "skill_name", "skill"),
        session.knownSecrets,
      ).value;
      const command = optionalDisplayField(
        "value",
        firstString(payload, "command", "description"),
        session.knownSecrets,
      ).value;
      try {
        const result = await this.deps.gate.check({
          sessionId: session.binding.canonicalSessionId,
          skillId: skillId ?? pluginName ?? null,
          toolName: toolName ?? pluginName ?? "hermes-native-tool",
          riskLevel: "review",
          params: {
            ...(toolName ? { toolName } : {}),
            ...(pluginName ? { pluginName } : {}),
            ...(command ? { command } : {}),
          },
          category: "hermes-native",
          isCancelled: () => !this.isNativeSessionCurrent(session),
        });
        choice = mapRiskGateDecisionToHermesApproval(result.decision);
      } catch {
        choice = "deny";
      }
      if (!this.isNativeSessionCurrent(session)) return;
      try {
        await runtime.respondApproval?.(session.binding, choice);
      } catch {
        // Fixed fail-closed path: never reflect control-plane errors or prompt data into history.
      }
      return;
    }

    const requestId = firstString(payload, "request_id");
    if (!requestId || !/^[0-9a-f]{8}$/u.test(requestId)) return;

    if (event.type === "sudo.request") {
      let password = "";
      if (prompter) {
        try {
          password = await prompter.requestSudo({
            kind: "sudo",
            sessionId: session.binding.canonicalSessionId,
            ...optionalDisplayField(
              "prompt",
              firstString(payload, "prompt", "message"),
              session.knownSecrets,
            ),
            ...optionalDisplayField(
              "command",
              firstString(payload, "command"),
              session.knownSecrets,
            ),
          });
        } catch {
          password = "";
        }
      }
      if (!this.isNativeSessionCurrent(session)) return;
      try {
        await runtime.respondSudo?.(session.binding, requestId, password);
      } catch {
        // Passwords and upstream errors stay out of logs and AgentEvent persistence.
      }
      return;
    }

    let value = "";
    if (prompter) {
      try {
        value = await prompter.requestSecret({
          kind: "secret",
          sessionId: session.binding.canonicalSessionId,
          ...optionalDisplayField(
            "prompt",
            firstString(payload, "prompt", "message"),
            session.knownSecrets,
          ),
          ...optionalDisplayField(
            "secretName",
            firstString(payload, "env_var", "secret_name", "name", "key"),
            session.knownSecrets,
          ),
        });
      } catch {
        value = "";
      }
    }
    if (!this.isNativeSessionCurrent(session)) return;
    if (value.length > 0) {
      session.mapper.registerSecret(value);
      if (!session.knownSecrets.includes(value)) session.knownSecrets.push(value);
    }
    try {
      await runtime.respondSecret?.(session.binding, requestId, value);
    } catch {
      // Secret values and upstream errors stay out of logs and AgentEvent persistence.
    }
  }

  private dispatchNative(session: NativeActiveSession, event: AgentEvent): void {
    this.persistEvent(event.sessionId, session.seq++, event);
    try {
      session.sink.send(event);
    } catch {
      console.error("[agent-service] event sink send failed");
    }
  }

  private isNativeSessionCurrent(session: NativeActiveSession): boolean {
    const sessionId = session.binding.canonicalSessionId;
    return (
      !this.disposed &&
      !session.revoked &&
      this.sessions.get(sessionId) === session &&
      this.registry.get(session.profile.id) === session.profile &&
      !this.profileMutations.has(session.profile.id) &&
      !this.blockedProfiles.has(session.profile.id)
    );
  }

  private persistEvent(sessionId: string, seq: number, event: AgentEvent | AgentUserEvent): void {
    try {
      this.deps.agentEvents.append({
        sessionId,
        seq,
        type: event.type,
        payload: event,
      });
    } catch {
      console.error("[agent-service] agent_events append failed");
    }
  }

  private nextEventSeq(sessionId: string): number {
    const rows = this.deps.agentEvents.readBySession(sessionId);
    return (rows.at(-1)?.seq ?? -1) + 1;
  }

  private updateBindingStatus(
    sessionId: string,
    status: AgentSessionStatus,
    resumable: boolean,
  ): AgentRuntimeBindingRow | undefined {
    const bindings = this.deps.agentRuntimeBindings;
    if (!bindings) return undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = bindings.get(sessionId);
      if (!current) return undefined;
      if (
        bindings.updateStatus({
          sessionId,
          status,
          resumable,
          expectedGeneration: current.generation,
          updatedAt: Date.now(),
        })
      ) {
        return bindings.get(sessionId);
      }
    }
    return undefined;
  }

  private runProfileMutation<T>(profileId: string, operation: () => T | Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error("agent service is disposed"));
    this.blockedProfiles.add(profileId);
    const previous = this.profileMutations.get(profileId);
    if (!previous) {
      try {
        const result = operation();
        if (!isPromiseLike(result)) {
          this.blockedProfiles.delete(profileId);
          return Promise.resolve(result);
        }
        return this.trackProfileMutation(profileId, Promise.resolve(result));
      } catch (cause) {
        return Promise.reject(cause);
      }
    }
    // A queued replacement must not run past a failed delete/invalidation. The failed Profile
    // stays blocked; a later explicit retry starts after this rejected queue entry is released.
    const attempt = previous.then(operation);
    return this.trackProfileMutation(profileId, attempt);
  }

  private trackProfileMutation<T>(profileId: string, attempt: Promise<T>): Promise<T> {
    this.profileMutations.set(profileId, attempt);
    const release = (succeeded: boolean): void => {
      if (this.profileMutations.get(profileId) === attempt) {
        this.profileMutations.delete(profileId);
        if (succeeded) this.blockedProfiles.delete(profileId);
      }
    };
    void attempt.then(
      () => release(true),
      () => release(false),
    );
    return attempt;
  }

  private runCredentialMutation<T>(
    credentialRef: string,
    operation: () => T | Promise<T>,
  ): T | Promise<T> {
    const previous = this.credentialMutations.get(credentialRef);
    if (!previous) {
      const result = operation();
      if (!isPromiseLike(result)) return result;
      return this.trackCredentialMutation(credentialRef, Promise.resolve(result));
    }
    const attempt = previous.catch(() => undefined).then(operation);
    return this.trackCredentialMutation(credentialRef, attempt);
  }

  private trackCredentialMutation<T>(credentialRef: string, attempt: Promise<T>): Promise<T> {
    this.credentialMutations.set(credentialRef, attempt);
    const release = (): void => {
      if (this.credentialMutations.get(credentialRef) === attempt) {
        this.credentialMutations.delete(credentialRef);
      }
    };
    void attempt.then(release, release);
    return attempt;
  }

  private trackProfileRuntimeOperation<T>(profileId: string, operation: Promise<T>): Promise<T> {
    let operations = this.profileRuntimeOperations.get(profileId);
    if (!operations) {
      operations = new Set();
      this.profileRuntimeOperations.set(profileId, operations);
    }
    operations.add(operation);
    const release = (): void => {
      operations?.delete(operation);
      if (operations?.size === 0 && this.profileRuntimeOperations.get(profileId) === operations) {
        this.profileRuntimeOperations.delete(profileId);
      }
    };
    void operation.then(release, release);
    return operation;
  }

  private async drainInFlightOperations(): Promise<void> {
    while (true) {
      const operations = new Set<Promise<unknown>>([
        ...this.profileMutations.values(),
        ...this.recoveries.values(),
        ...[...this.profileRuntimeOperations.values()].flatMap((entries) => [...entries]),
      ]);
      if (operations.size === 0) return;
      await Promise.allSettled(operations);
    }
  }

  private async invalidateHermesProfile(profileId: string): Promise<void> {
    const runtime = this.requireNativeRuntime();
    const inFlight = [...(this.profileRuntimeOperations.get(profileId) ?? [])];
    const invalidateProfile = runtime.invalidateProfile?.bind(runtime);
    let failed = false;
    const cleanupRound = async (): Promise<void> => {
      const closing: RuntimeBinding[] = [];
      for (const [sessionId, session] of this.sessions) {
        if (session.kind !== "hermes" || session.profile.id !== profileId) continue;
        session.revoked = true;
        this.sessions.delete(sessionId);
        closing.push(session.binding);
      }
      try {
        this.deps.agentRuntimeBindings?.invalidateProfile(profileId, Date.now());
      } catch {
        failed = true;
      }

      let invalidation: Promise<void>;
      try {
        invalidation = invalidateProfile
          ? invalidateProfile(profileId)
          : Promise.reject(new Error("profile invalidation unavailable"));
      } catch {
        invalidation = Promise.reject(new Error("profile invalidation failed"));
      }
      const results = await Promise.allSettled([
        invalidation,
        ...closing.map((binding) => Promise.resolve().then(() => runtime.close(binding))),
      ]);
      if (results.slice(1).some((result) => result.status === "rejected")) {
        console.error("[agent-service] Hermes profile session close failed");
      }
      if (results[0]?.status === "rejected") failed = true;
    };

    await cleanupRound();
    this.assertNotDisposed();
    if (inFlight.length > 0) {
      await Promise.allSettled(inFlight);
      this.assertNotDisposed();
      await cleanupRound();
      this.assertNotDisposed();
    }
    if (failed) throw new Error("Hermes profile invalidation failed");
  }

  private assertProfileCurrent(profile: ProviderProfile): void {
    if (
      this.profileMutations.has(profile.id) ||
      this.blockedProfiles.has(profile.id) ||
      this.registry.get(profile.id) !== profile
    ) {
      throw new Error("Hermes provider profile changed during session launch");
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("agent service is disposed");
  }

  private async loadKnownSecrets(profile: ProviderProfile): Promise<string[]> {
    if (!profile.credentialRef) return [];
    const secret = await this.deps.credentials.get(profile.credentialRef);
    return secret ? [secret] : [];
  }

  private requireNativeRuntime(): RuntimeAdapter {
    const runtime = this.deps.runtime;
    if (runtime?.kind !== "hermes") throw new Error("Hermes runtime is unavailable");
    return runtime;
  }

  private requireRuntimeBindings(): AgentRuntimeBindingService {
    const bindings = this.deps.agentRuntimeBindings;
    if (!bindings) throw new Error("Hermes runtime binding storage is unavailable");
    return bindings;
  }

  // 事件分发：先落库（持久化回放），再推 renderer；落库失败不阻断推送
  private dispatch(session: LegacyActiveSession, sessionId: string, event: AgentEvent): void {
    this.persistEvent(sessionId, session.seq++, event);
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

function nativeErrorEvent(sessionId: string, message: string, recoverable: boolean): AgentEvent {
  return { type: "agent_error", sessionId, message, recoverable };
}

function nativeResultEvent(
  sessionId: string,
  subtype: "success" | "error" | "aborted",
  durationMs: number,
  errorMessage?: string,
): AgentEvent {
  return {
    type: "agent_session_result",
    sessionId,
    subtype,
    durationMs,
    numSteps: subtype === "success" ? 1 : 0,
    totalCostUsd: null,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function toAgentSessionMeta(row: AgentSessionRow): AgentSessionMeta {
  const base = {
    sessionId: row.sessionId,
    title: row.title,
    model: row.model,
    createdAt: row.createdAt,
  };
  if (
    row.profileId !== undefined &&
    row.workspaceRoot !== undefined &&
    row.status !== undefined &&
    row.resumable !== undefined
  ) {
    return {
      ...base,
      profileId: row.profileId,
      workspaceRoot: row.workspaceRoot,
      status: row.status,
      resumable: row.resumable,
    };
  }
  return base;
}

function isHermesInteractionEvent(type: string): boolean {
  return type === "approval.request" || type === "sudo.request" || type === "secret.request";
}

function profileTrustBoundaryErrorMessage(profile: ProviderProfile): string {
  return profile.hermes.authMode === "oauth"
    ? UNSUPPORTED_HERMES_OAUTH_PROFILE
    : UNSUPPORTED_HERMES_API_KEY_PROFILE;
}

function isCanonicalApiKeyProfile(profile: ProviderProfile): boolean {
  try {
    if (profile.hermes.authMode !== "api_key") return false;
    const canonical = ProviderProfileSchema.parse({ ...profile, hermes: undefined });
    if (
      canonical.hermes.authMode !== profile.hermes.authMode ||
      canonical.hermes.providerSlug !== profile.hermes.providerSlug ||
      canonical.hermes.apiMode !== profile.hermes.apiMode
    ) {
      return false;
    }
    if (profile.kind !== "openai-compatible") return profile.baseUrl === undefined;
    if (!profile.baseUrl || profile.baseUrl.length > MAX_PROVIDER_BASE_URL_LENGTH) return false;
    const endpoint = new URL(profile.baseUrl);
    return Boolean(
      (endpoint.protocol === "https:" || endpoint.protocol === "http:") &&
        endpoint.hostname &&
        !endpoint.username &&
        !endpoint.password,
    );
  } catch {
    return false;
  }
}

function profileHomeAuthorityChanged(
  existing: ProviderProfile,
  candidate: ProviderProfile,
): boolean {
  return profileHomeAuthorityHash(existing) !== profileHomeAuthorityHash(candidate);
}

function isPromiseLike<T>(value: T | Promise<T> | undefined): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(
  value: Record<string, unknown> | undefined,
  ...fields: string[]
): string | undefined {
  for (const field of fields) {
    const candidate = value?.[field];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function optionalDisplayField<Key extends string>(
  key: Key,
  value: string | undefined,
  knownSecrets: readonly string[],
): Partial<Record<Key, string>> {
  if (value === undefined) return {};
  let safe = value.replaceAll("\0", "");
  for (const secret of knownSecrets) {
    if (secret.length > 0) safe = safe.replaceAll(secret, "[REDACTED]");
  }
  safe = safe.slice(0, 4_096);
  while (new TextEncoder().encode(safe).length > 16_384) safe = safe.slice(0, -1);
  return { [key]: safe } as Partial<Record<Key, string>>;
}
