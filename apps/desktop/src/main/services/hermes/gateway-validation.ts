import type {
  HermesGatewayRequestMethod,
  HermesGatewayRequestParams,
  HermesGatewayRequestResult,
} from "./gateway-protocol";

type Validator = (value: unknown) => boolean;

const LIVE_SESSION_ID_PATTERN = /^[0-9a-f]{8}$/u;
const STORED_SESSION_ID_PATTERN = /^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/u;
const MAX_PROMPT_CHARACTERS = 262_144;
const MAX_PROMPT_UTF8_BYTES = 1024 * 1024;

const REQUEST_KEYS: Readonly<Record<HermesGatewayRequestMethod, ReadonlySet<string>>> = {
  "session.create": new Set(),
  "session.resume": new Set(["session_id"]),
  "prompt.submit": new Set(["session_id", "text"]),
  "session.interrupt": new Set(["session_id"]),
  "session.close": new Set(["session_id"]),
  "session.status": new Set(["session_id"]),
  "approval.respond": new Set(["session_id", "choice"]),
};

const REQUEST_VALIDATORS: Readonly<Record<HermesGatewayRequestMethod, Validator>> = {
  "session.create": isRecord,
  "session.resume": (value) => isRecord(value) && isStoredSessionId(value.session_id),
  "prompt.submit": (value) =>
    isRecord(value) && isLiveSessionId(value.session_id) && isValidPromptText(value.text),
  "session.interrupt": hasLiveSessionId,
  "session.close": hasLiveSessionId,
  "session.status": hasLiveSessionId,
  "approval.respond": (value) =>
    isRecord(value) &&
    isLiveSessionId(value.session_id) &&
    (value.choice === "once" || value.choice === "deny"),
};

const RESULT_VALIDATORS: Readonly<Record<HermesGatewayRequestMethod, Validator>> = {
  "session.create": (value) =>
    isRecord(value) &&
    isLiveSessionId(value.session_id) &&
    isStoredSessionId(value.stored_session_id) &&
    isNonNegativeInteger(value.message_count) &&
    Array.isArray(value.messages) &&
    isRecord(value.info),
  "session.resume": (value) =>
    isRecord(value) &&
    isLiveSessionId(value.session_id) &&
    (value.resumed === undefined || isStoredSessionId(value.resumed)) &&
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

function hasLiveSessionId(value: unknown): boolean {
  return isRecord(value) && isLiveSessionId(value.session_id);
}

function isLiveSessionId(value: unknown): value is string {
  return typeof value === "string" && LIVE_SESSION_ID_PATTERN.test(value);
}

function isStoredSessionId(value: unknown): value is string {
  return typeof value === "string" && STORED_SESSION_ID_PATTERN.test(value);
}

function isValidPromptText(value: unknown): value is string {
  if (typeof value !== "string") return false;

  let characters = 0;
  let utf8Bytes = 0;
  let hasNonWhitespace = false;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let codePoint = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const second = value.charCodeAt(index + 1);
      if (second < 0xdc00 || second > 0xdfff) return false;
      codePoint = 0x10000 + (first - 0xd800) * 0x400 + (second - 0xdc00);
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      return false;
    }

    characters += 1;
    if (characters > MAX_PROMPT_CHARACTERS) return false;
    utf8Bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (utf8Bytes > MAX_PROMPT_UTF8_BYTES) return false;
    if (!isPythonWhitespace(codePoint)) hasNonWhitespace = true;
  }
  return hasNonWhitespace;
}

function isPythonWhitespace(codePoint: number): boolean {
  return (
    (codePoint >= 0x0009 && codePoint <= 0x000d) ||
    (codePoint >= 0x001c && codePoint <= 0x0020) ||
    codePoint === 0x0085 ||
    codePoint === 0x00a0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
