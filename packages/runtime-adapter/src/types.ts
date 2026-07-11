export type RuntimeKind = "legacy" | "hermes";

export interface RuntimeReady {
  readonly version: string;
}

export interface RuntimeBinding {
  readonly canonicalSessionId: string;
  readonly liveRuntimeSessionId: string;
  readonly durableRuntimeSessionId: string | null;
}

export interface RuntimeCreateInput {
  readonly canonicalSessionId: string;
}

export interface RuntimeResumeInput {
  readonly canonicalSessionId: string;
  readonly durableRuntimeSessionId: string;
}

export interface RuntimeEvent {
  readonly type: string;
  readonly payload: unknown;
}

export type RuntimeEventSink = (event: RuntimeEvent) => void;

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
