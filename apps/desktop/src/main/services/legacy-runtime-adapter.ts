import type { AgentSessionHandle } from "@opentrad/agent-core";
import {
  type RuntimeAdapter,
  type RuntimeBinding,
  type RuntimeCrashListener,
  type RuntimeCreateInput,
  type RuntimeEventSink,
  type RuntimeResumeInput,
  RuntimeResumeUnsupportedError,
} from "@opentrad/runtime-adapter";

export type LegacySessionFactory = (input: RuntimeCreateInput) => AgentSessionHandle;

interface LegacySessionState {
  readonly canonicalSessionId: string;
  readonly handle: AgentSessionHandle;
  aborted: boolean;
}

export class LegacyRuntimeAdapter implements RuntimeAdapter {
  readonly kind = "legacy" as const;
  private readonly sessions = new Map<string, LegacySessionState>();
  private readonly liveSessionByCanonical = new Map<string, string>();

  constructor(private readonly createSession: LegacySessionFactory) {}

  async ready(): Promise<{ version: string }> {
    return { version: "legacy" };
  }

  async create(input: RuntimeCreateInput): Promise<RuntimeBinding> {
    if (this.liveSessionByCanonical.has(input.canonicalSessionId)) {
      throw new Error(`canonical runtime session already exists: ${input.canonicalSessionId}`);
    }
    const handle = this.createSession(input);
    if (this.sessions.has(handle.sessionId)) {
      try {
        handle.abort();
      } catch (cause) {
        throw new Error(`duplicate live runtime session cleanup failed: ${handle.sessionId}`, {
          cause,
        });
      }
      throw new Error(`live runtime session already exists: ${handle.sessionId}`);
    }
    this.sessions.set(handle.sessionId, {
      canonicalSessionId: input.canonicalSessionId,
      handle,
      aborted: false,
    });
    this.liveSessionByCanonical.set(input.canonicalSessionId, handle.sessionId);
    return {
      canonicalSessionId: input.canonicalSessionId,
      liveRuntimeSessionId: handle.sessionId,
      durableRuntimeSessionId: null,
    };
  }

  async stream(binding: RuntimeBinding, prompt: string, emit: RuntimeEventSink): Promise<void> {
    const { handle } = this.requireSession(binding);
    const unsubscribe = handle.onEvent((event) => {
      emit({ type: event.type, payload: event });
    });
    try {
      await handle.send(prompt);
    } finally {
      unsubscribe();
    }
  }

  async interrupt(binding: RuntimeBinding): Promise<void> {
    const state = this.sessions.get(binding.liveRuntimeSessionId);
    if (state?.canonicalSessionId === binding.canonicalSessionId) this.abortOnce(state);
  }

  async close(binding: RuntimeBinding): Promise<void> {
    const state = this.sessions.get(binding.liveRuntimeSessionId);
    if (!state || state.canonicalSessionId !== binding.canonicalSessionId) return;
    try {
      this.abortOnce(state);
    } finally {
      this.sessions.delete(binding.liveRuntimeSessionId);
      this.liveSessionByCanonical.delete(state.canonicalSessionId);
    }
  }

  async resume(_input: RuntimeResumeInput): Promise<RuntimeBinding> {
    throw new RuntimeResumeUnsupportedError(this.kind);
  }

  onCrash(_listener: RuntimeCrashListener): () => void {
    return () => {};
  }

  async dispose(): Promise<void> {
    const states = [...this.sessions.values()];
    this.sessions.clear();
    this.liveSessionByCanonical.clear();
    let firstError: unknown;
    for (const state of states) {
      try {
        this.abortOnce(state);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  private requireSession(binding: RuntimeBinding): LegacySessionState {
    const state = this.sessions.get(binding.liveRuntimeSessionId);
    if (!state || state.canonicalSessionId !== binding.canonicalSessionId) {
      throw new Error(`unknown legacy runtime session: ${binding.liveRuntimeSessionId}`);
    }
    return state;
  }

  private abortOnce(state: LegacySessionState): void {
    if (state.aborted) return;
    state.aborted = true;
    state.handle.abort();
  }
}
