import type { RuntimeEvent } from "@opentrad/runtime-adapter";
import type { AgentEvent } from "@opentrad/shared";

export interface HermesEventMapperOptions {
  readonly canonicalSessionId: string;
  readonly profileId: string;
  readonly model: string;
  readonly knownSecrets: readonly string[];
}

export interface HermesEventMapper {
  map(event: RuntimeEvent): AgentEvent[];
  registerSecret(value: string): void;
  flush(): AgentEvent[];
  finalize(): AgentEvent[];
}

export function createHermesEventMapper(options: HermesEventMapperOptions): HermesEventMapper {
  return new StatefulHermesEventMapper(options);
}

class StatefulHermesEventMapper implements HermesEventMapper {
  private readonly knownSecrets: string[];
  private startEmitted = false;
  private messageSequence = 0;
  private currentMessageId: string | undefined;
  private currentMessageHasText = false;
  private currentThinkingHasText = false;
  private messageRedactor: StreamingLiteralRedactor | undefined;
  private thinkingRedactor: StreamingLiteralRedactor | undefined;

  constructor(private readonly options: HermesEventMapperOptions) {
    this.knownSecrets = normalizeSecrets(options.knownSecrets);
  }

  map(event: RuntimeEvent): AgentEvent[] {
    switch (event.type) {
      case "session.info":
        return this.mapSessionInfo(event.payload);
      case "message.start":
        this.startMessage();
        return [];
      case "message.delta":
        return this.mapMessageDelta(event.payload);
      case "message.complete":
        return this.mapMessageComplete(event.payload);
      case "reasoning.delta":
      case "reasoning.available":
      case "thinking.delta":
        return this.mapThinkingDelta(event.payload);
      case "tool.start":
        return this.mapToolStart(event.payload);
      case "tool.complete":
        return this.mapToolComplete(event.payload);
      case "error":
        return this.mapError(event.payload);
      default:
        return [];
    }
  }

  registerSecret(value: string): void {
    if (value.length === 0 || this.knownSecrets.includes(value)) return;
    this.knownSecrets.push(value);
    this.knownSecrets.sort((left, right) => right.length - left.length);
  }

  flush(): AgentEvent[] {
    if (!this.currentMessageId) return [];
    const events: AgentEvent[] = [];
    this.flushThinkingInto(events);
    this.flushMessageInto(events);
    return events;
  }

  finalize(): AgentEvent[] {
    const msgId = this.currentMessageId;
    if (!msgId) return [];

    const events = this.flush();
    if (this.currentThinkingHasText) {
      events.push(this.thinkingEvent(msgId, "", true));
    }
    events.push(this.textEvent(msgId, "", true));
    this.resetMessage();
    return events;
  }

  private mapSessionInfo(payloadValue: unknown): AgentEvent[] {
    if (this.startEmitted) return [];
    this.startEmitted = true;
    const payload = recordOf(payloadValue);
    const model = typeof payload?.model === "string" ? payload.model : this.options.model;
    return [
      {
        type: "agent_session_start",
        sessionId: this.options.canonicalSessionId,
        profileId: this.options.profileId,
        model,
        tools: flattenToolNames(payload?.tools),
      },
    ];
  }

  private startMessage(): string {
    this.messageSequence += 1;
    this.currentMessageId = `${this.options.canonicalSessionId}#m${this.messageSequence}`;
    this.currentMessageHasText = false;
    this.currentThinkingHasText = false;
    this.messageRedactor = new StreamingLiteralRedactor(this.knownSecrets);
    this.thinkingRedactor = new StreamingLiteralRedactor(this.knownSecrets);
    return this.currentMessageId;
  }

  private activeMessageId(): string {
    return this.currentMessageId ?? this.startMessage();
  }

  private mapMessageDelta(payloadValue: unknown): AgentEvent[] {
    const text = stringField(payloadValue, "text");
    if (text === undefined || text.length === 0) return [];
    const msgId = this.activeMessageId();
    this.currentMessageHasText = true;
    const redacted = this.messageRedactor?.feed(text) ?? text;
    return redacted.length > 0 ? [this.textEvent(msgId, redacted, false)] : [];
  }

  private mapMessageComplete(payloadValue: unknown): AgentEvent[] {
    const msgId = this.activeMessageId();
    const events: AgentEvent[] = [];

    if (!this.currentThinkingHasText) {
      const reasoning = stringField(payloadValue, "reasoning");
      if (reasoning) events.push(...this.mapThinkingDelta({ text: reasoning }));
    }
    this.flushThinkingInto(events);
    if (this.currentThinkingHasText) {
      events.push(this.thinkingEvent(msgId, "", true));
    }

    if (!this.currentMessageHasText) {
      const text = stringField(payloadValue, "text");
      if (text) events.push(...this.mapMessageDelta({ text }));
    }
    this.flushMessageInto(events);
    events.push(this.textEvent(msgId, "", true));

    const usageEvent = this.mapUsage(payloadValue, msgId);
    if (usageEvent) events.push(usageEvent);

    this.resetMessage();
    return events;
  }

  private mapThinkingDelta(payloadValue: unknown): AgentEvent[] {
    const text = stringField(payloadValue, "text");
    if (text === undefined || text.length === 0) return [];
    const msgId = this.activeMessageId();
    this.currentThinkingHasText = true;
    const redacted = this.thinkingRedactor?.feed(text) ?? text;
    return redacted.length > 0 ? [this.thinkingEvent(msgId, redacted, false)] : [];
  }

  private mapToolStart(payloadValue: unknown): AgentEvent[] {
    const payload = recordOf(payloadValue);
    const toolCallId = stringField(payload, "tool_id");
    const toolName = stringField(payload, "name");
    if (!payload || !toolCallId || !toolName) return [];

    return [
      {
        type: "agent_tool_call",
        sessionId: this.options.canonicalSessionId,
        msgId: this.activeMessageId(),
        toolCallId,
        toolName,
        input: redactNested(toolInput(payload), this.knownSecrets),
      },
    ];
  }

  private mapToolComplete(payloadValue: unknown): AgentEvent[] {
    const payload = recordOf(payloadValue);
    const toolCallId = stringField(payload, "tool_id");
    const toolName = stringField(payload, "name");
    if (!payload || !toolCallId || !toolName) return [];

    const rawOutput = Object.hasOwn(payload, "result") ? payload.result : payload.output;
    const output = redactNested(rawOutput, this.knownSecrets);
    const outputRecord = recordOf(rawOutput);
    const isError =
      booleanField(payload, "is_error") ??
      booleanField(payload, "isError") ??
      (outputRecord?.error === true ? true : undefined);
    const denied =
      booleanField(payload, "denied") ??
      (typeof outputRecord?.denied === "boolean" ? outputRecord.denied : undefined);

    return [
      {
        type: "agent_tool_result",
        sessionId: this.options.canonicalSessionId,
        toolCallId,
        toolName,
        output,
        ...(isError === undefined ? {} : { isError }),
        ...(denied === undefined ? {} : { denied }),
      },
    ];
  }

  private mapUsage(payloadValue: unknown, msgId: string): AgentEvent | undefined {
    const usage = recordOf(recordOf(payloadValue)?.usage);
    if (!usage) return undefined;
    const inputTokens = integerField(usage, "input") ?? integerField(usage, "prompt");
    const outputTokens = integerField(usage, "output") ?? integerField(usage, "completion");
    if (inputTokens === undefined && outputTokens === undefined) return undefined;

    return {
      type: "agent_usage",
      sessionId: this.options.canonicalSessionId,
      msgId,
      usage: {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
      },
      estimatedCostUsd: null,
    };
  }

  private mapError(payloadValue: unknown): AgentEvent[] {
    const payload = recordOf(payloadValue);
    const message = stringField(payload, "message") ?? "Hermes runtime error";
    return [
      {
        type: "agent_error",
        sessionId: this.options.canonicalSessionId,
        message: redactLiteral(message, this.knownSecrets),
        recoverable: booleanField(payload, "recoverable") ?? true,
      },
    ];
  }

  private flushThinkingInto(events: AgentEvent[]): void {
    const msgId = this.currentMessageId;
    if (!msgId) return;
    const tail = this.thinkingRedactor?.flush() ?? "";
    if (tail) events.push(this.thinkingEvent(msgId, tail, false));
  }

  private flushMessageInto(events: AgentEvent[]): void {
    const msgId = this.currentMessageId;
    if (!msgId) return;
    const tail = this.messageRedactor?.flush() ?? "";
    if (tail) events.push(this.textEvent(msgId, tail, false));
  }

  private textEvent(msgId: string, delta: string, done: boolean): AgentEvent {
    return {
      type: "agent_text",
      sessionId: this.options.canonicalSessionId,
      msgId,
      delta,
      done,
    };
  }

  private thinkingEvent(msgId: string, delta: string, done: boolean): AgentEvent {
    return {
      type: "agent_thinking",
      sessionId: this.options.canonicalSessionId,
      msgId,
      delta,
      done,
    };
  }

  private resetMessage(): void {
    this.currentMessageId = undefined;
    this.currentMessageHasText = false;
    this.currentThinkingHasText = false;
    this.messageRedactor = undefined;
    this.thinkingRedactor = undefined;
  }
}

const REDACTION = "[REDACTED]";

class StreamingLiteralRedactor {
  private pending = "";

  constructor(private readonly secrets: readonly string[]) {}

  feed(text: string): string {
    if (this.secrets.length === 0) return text;

    let candidate = this.pending + text;
    let output = "";
    while (candidate.length > 0) {
      const mustWait = this.secrets.some(
        (secret) => secret.length > candidate.length && secret.startsWith(candidate),
      );
      if (mustWait) break;

      const match = this.secrets.find((secret) => candidate.startsWith(secret));
      if (match) {
        output += REDACTION;
        candidate = candidate.slice(match.length);
        continue;
      }

      if (this.secrets.some((secret) => secret.startsWith(candidate))) break;
      output += candidate[0];
      candidate = candidate.slice(1);
    }
    this.pending = candidate;
    return output;
  }

  flush(): string {
    if (this.pending.length === 0) return "";
    this.pending = "";
    return REDACTION;
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function flattenToolNames(value: unknown): string[] {
  const groups = recordOf(value);
  if (!groups) return [];
  const names = new Set<string>();
  for (const group of Object.values(groups)) {
    if (!Array.isArray(group)) continue;
    for (const name of group) {
      if (typeof name === "string") names.add(name);
    }
  }
  return [...names];
}

function stringField(value: unknown, field: string): string | undefined {
  const record = recordOf(value);
  return typeof record?.[field] === "string" ? record[field] : undefined;
}

function booleanField(value: unknown, field: string): boolean | undefined {
  const record = recordOf(value);
  return typeof record?.[field] === "boolean" ? record[field] : undefined;
}

function integerField(value: unknown, field: string): number | undefined {
  const record = recordOf(value);
  const fieldValue = record?.[field];
  return typeof fieldValue === "number" && Number.isFinite(fieldValue)
    ? Math.max(0, Math.trunc(fieldValue))
    : undefined;
}

function toolInput(payload: Record<string, unknown>): unknown {
  if (Object.hasOwn(payload, "args")) return payload.args;
  if (Object.hasOwn(payload, "input")) return payload.input;
  const argsText = stringField(payload, "args_text");
  if (argsText === undefined) return {};
  try {
    return JSON.parse(argsText);
  } catch {
    return argsText;
  }
}

function normalizeSecrets(secrets: readonly string[]): string[] {
  return [...new Set(secrets.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
}

function redactLiteral(value: string, secrets: readonly string[]): string {
  let remaining = value;
  let redacted = "";
  while (remaining.length > 0) {
    const match = secrets.find((secret) => remaining.startsWith(secret));
    if (match) {
      redacted += REDACTION;
      remaining = remaining.slice(match.length);
      continue;
    }
    redacted += remaining[0];
    remaining = remaining.slice(1);
  }
  return redacted;
}

function redactNested(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactLiteral(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactNested(entry, secrets));
  const record = recordOf(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, redactNested(entry, secrets)]),
  );
}
