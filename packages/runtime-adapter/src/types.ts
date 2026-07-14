export type RuntimeKind = "legacy" | "hermes";

export interface RuntimeReady {
  readonly version: string;
}

export interface RuntimeBinding {
  readonly canonicalSessionId: string;
  readonly liveRuntimeSessionId: string;
  readonly durableRuntimeSessionId: string | null;
}

export type RuntimeProviderApiMode = "chat_completions" | "codex_responses";
export type RuntimeProviderAuthMode = "api_key" | "oauth";
export type RuntimeExecutionBackend = "local" | "docker";

export interface RuntimeProviderSelection {
  readonly profileId: string;
  readonly providerSlug: string;
  readonly authMode: RuntimeProviderAuthMode;
  readonly model: string;
  readonly apiMode: RuntimeProviderApiMode;
  readonly executionBackend: RuntimeExecutionBackend;
}

export interface RuntimeSessionLaunchContext {
  readonly canonicalSessionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly provider: RuntimeProviderSelection;
}

export type RuntimeCreateInput = RuntimeSessionLaunchContext;

export interface RuntimeResumeInput extends RuntimeSessionLaunchContext {
  readonly durableRuntimeSessionId: string;
}

export interface RuntimeEvent {
  readonly type: string;
  readonly payload: unknown;
}

export type RuntimeEventSink = (event: RuntimeEvent) => void;

export type RuntimeApprovalChoice = "once" | "session" | "always" | "deny";

export interface RuntimeCrash {
  readonly runtimeKind: RuntimeKind;
  readonly binding: RuntimeBinding | null;
  readonly error: unknown;
}

export type RuntimeCrashListener = (crash: RuntimeCrash) => void;

export interface RuntimeAdapter {
  readonly kind: RuntimeKind;
  ready(): Promise<RuntimeReady>;
  create(input: RuntimeCreateInput): Promise<RuntimeBinding>;
  stream(binding: RuntimeBinding, prompt: string, emit: RuntimeEventSink): Promise<void>;
  interrupt(binding: RuntimeBinding): Promise<void>;
  close(binding: RuntimeBinding): Promise<void>;
  resume(input: RuntimeResumeInput): Promise<RuntimeBinding>;
  respondApproval?(binding: RuntimeBinding, choice: RuntimeApprovalChoice): Promise<void>;
  respondSudo?(binding: RuntimeBinding, requestId: string, password: string): Promise<void>;
  respondSecret?(binding: RuntimeBinding, requestId: string, value: string): Promise<void>;
  invalidateProfile?(profileId: string): Promise<void>;
  onCrash(listener: RuntimeCrashListener): () => void;
  dispose(): Promise<void>;
}

export class RuntimeResumeUnsupportedError extends Error {
  readonly runtimeKind: RuntimeKind;

  constructor(runtimeKind: RuntimeKind) {
    super(`${runtimeKind} runtime does not support session resume`);
    this.name = "RuntimeResumeUnsupportedError";
    this.runtimeKind = runtimeKind;
  }
}
