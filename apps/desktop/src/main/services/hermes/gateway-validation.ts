import type {
  HermesGatewayRequestMethod,
  HermesGatewayRequestParams,
  HermesGatewayRequestResult,
} from "./gateway-protocol";

type Validator = (value: unknown) => boolean;

const REQUEST_KEYS: Readonly<Record<HermesGatewayRequestMethod, ReadonlySet<string>>> = {
  "session.create": new Set([
    "cwd",
    "source",
    "close_on_disconnect",
    "cols",
    "messages",
    "title",
    "parent_session_id",
    "profile",
    "model",
    "provider",
    "reasoning_effort",
    "fast",
  ]),
  "session.resume": new Set(["session_id", "cols", "profile"]),
  "prompt.submit": new Set(["session_id", "text", "truncate_before_user_ordinal"]),
  "session.interrupt": new Set(["session_id"]),
  "session.close": new Set(["session_id"]),
  "session.status": new Set(["session_id"]),
  "approval.respond": new Set(["session_id", "choice", "all"]),
};

const REQUEST_VALIDATORS: Readonly<Record<HermesGatewayRequestMethod, Validator>> = {
  "session.create": (value) =>
    isRecord(value) &&
    isNonEmptyString(value.cwd) &&
    value.source === "opentrad" &&
    value.close_on_disconnect === true &&
    optionalPositiveInteger(value.cols) &&
    (value.messages === undefined || Array.isArray(value.messages)) &&
    optionalString(value.title) &&
    optionalString(value.parent_session_id) &&
    optionalString(value.profile) &&
    optionalString(value.model) &&
    optionalString(value.provider) &&
    optionalString(value.reasoning_effort) &&
    optionalBoolean(value.fast),
  "session.resume": (value) =>
    isRecord(value) &&
    isNonEmptyString(value.session_id) &&
    optionalPositiveInteger(value.cols) &&
    optionalString(value.profile),
  "prompt.submit": (value) =>
    isRecord(value) &&
    isNonEmptyString(value.session_id) &&
    typeof value.text === "string" &&
    optionalNonNegativeInteger(value.truncate_before_user_ordinal),
  "session.interrupt": hasSessionId,
  "session.close": hasSessionId,
  "session.status": hasSessionId,
  "approval.respond": (value) =>
    isRecord(value) &&
    isNonEmptyString(value.session_id) &&
    (value.choice === "once" ||
      value.choice === "session" ||
      value.choice === "always" ||
      value.choice === "deny") &&
    optionalBoolean(value.all),
};

const RESULT_VALIDATORS: Readonly<Record<HermesGatewayRequestMethod, Validator>> = {
  "session.create": (value) =>
    isRecord(value) &&
    isNonEmptyString(value.session_id) &&
    isNonEmptyString(value.stored_session_id) &&
    isNonNegativeInteger(value.message_count) &&
    Array.isArray(value.messages) &&
    isRecord(value.info),
  "session.resume": (value) =>
    isRecord(value) &&
    isNonEmptyString(value.session_id) &&
    optionalString(value.resumed) &&
    isNonNegativeInteger(value.message_count) &&
    Array.isArray(value.messages) &&
    isRecord(value.info) &&
    typeof value.running === "boolean" &&
    isNonEmptyString(value.session_key) &&
    typeof value.started_at === "number" &&
    Number.isFinite(value.started_at) &&
    (value.status === "idle" ||
      value.status === "starting" ||
      value.status === "waiting" ||
      value.status === "working" ||
      value.status === "streaming"),
  "prompt.submit": (value) =>
    isRecord(value) &&
    (value.status === "streaming" || value.status === "queued" || value.status === "steered"),
  "session.interrupt": (value) => isRecord(value) && value.status === "interrupted",
  "session.close": (value) => isRecord(value) && typeof value.closed === "boolean",
  "session.status": (value) => isRecord(value) && typeof value.output === "string",
  "approval.respond": (value) => isRecord(value) && isNonNegativeInteger(value.resolved),
};

export function isValidHermesGatewayRequestParams<TMethod extends HermesGatewayRequestMethod>(
  method: TMethod,
  value: unknown,
): value is HermesGatewayRequestParams<TMethod> {
  try {
    return (
      isRecord(value) &&
      hasOnlyKeys(value, REQUEST_KEYS[method]) &&
      REQUEST_VALIDATORS[method](value)
    );
  } catch {
    return false;
  }
}

export function isValidHermesGatewayRequestResult<TMethod extends HermesGatewayRequestMethod>(
  method: TMethod,
  value: unknown,
): value is HermesGatewayRequestResult<TMethod> {
  try {
    return RESULT_VALIDATORS[method](value);
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasSessionId(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.session_id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

function optionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}
