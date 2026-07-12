export const HERMES_GATEWAY_REQUEST_METHODS = [
  "session.create",
  "prompt.submit",
  "session.interrupt",
  "session.close",
  "session.resume",
  "session.status",
  "approval.respond",
] as const;

export type HermesGatewayRequestMethod = (typeof HERMES_GATEWAY_REQUEST_METHODS)[number];

export type HermesSessionCreateParams = Readonly<Record<string, never>>;

export interface HermesSessionCreateResult {
  readonly session_id: string;
  readonly stored_session_id: string;
  readonly message_count: number;
  readonly messages: readonly unknown[];
  readonly info: Readonly<Record<string, unknown>>;
}

export interface HermesSessionResumeParams {
  readonly session_id: string;
}

export interface HermesSessionResumeResult {
  readonly session_id: string;
  readonly resumed?: string;
  readonly message_count: number;
  readonly messages: readonly unknown[];
  readonly info: Readonly<Record<string, unknown>>;
  readonly inflight?: unknown;
  readonly running: boolean;
  readonly session_key: string;
  readonly started_at: number;
  readonly status: "idle" | "starting" | "waiting" | "working" | "streaming";
}

export interface HermesPromptSubmitParams {
  readonly session_id: string;
  readonly text: string;
}

export interface HermesPromptSubmitResult {
  readonly status: "streaming" | "queued" | "steered";
}

export interface HermesSessionScopedParams {
  readonly session_id: string;
}

export interface HermesSessionInterruptResult {
  readonly status: "interrupted";
}

export interface HermesSessionCloseResult {
  readonly closed: boolean;
}

export interface HermesSessionStatusResult {
  readonly output: string;
}

export type HermesApprovalChoice = "once" | "deny";

export interface HermesApprovalRespondParams {
  readonly session_id: string;
  readonly choice: HermesApprovalChoice;
}

export interface HermesApprovalRespondResult {
  readonly resolved: number;
}

export interface HermesGatewayRpcMap {
  readonly "session.create": {
    readonly params: HermesSessionCreateParams;
    readonly result: HermesSessionCreateResult;
  };
  readonly "prompt.submit": {
    readonly params: HermesPromptSubmitParams;
    readonly result: HermesPromptSubmitResult;
  };
  readonly "session.interrupt": {
    readonly params: HermesSessionScopedParams;
    readonly result: HermesSessionInterruptResult;
  };
  readonly "session.close": {
    readonly params: HermesSessionScopedParams;
    readonly result: HermesSessionCloseResult;
  };
  readonly "session.resume": {
    readonly params: HermesSessionResumeParams;
    readonly result: HermesSessionResumeResult;
  };
  readonly "session.status": {
    readonly params: HermesSessionScopedParams;
    readonly result: HermesSessionStatusResult;
  };
  readonly "approval.respond": {
    readonly params: HermesApprovalRespondParams;
    readonly result: HermesApprovalRespondResult;
  };
}

export type HermesGatewayRequestParams<TMethod extends HermesGatewayRequestMethod> =
  HermesGatewayRpcMap[TMethod]["params"];

export type HermesGatewayRequestResult<TMethod extends HermesGatewayRequestMethod> =
  HermesGatewayRpcMap[TMethod]["result"];

const HERMES_GATEWAY_REQUEST_METHOD_SET = new Set<string>(HERMES_GATEWAY_REQUEST_METHODS);

export function isHermesGatewayRequestMethod(value: unknown): value is HermesGatewayRequestMethod {
  return typeof value === "string" && HERMES_GATEWAY_REQUEST_METHOD_SET.has(value);
}
