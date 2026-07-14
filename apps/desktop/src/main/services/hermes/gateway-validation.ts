import { isAbsolute } from "node:path";
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
const MAX_CWD_CHARACTERS = 4_096;
const MAX_CWD_UTF8_BYTES = 16_384;
const MAX_MODEL_OR_PROVIDER_CHARACTERS = 512;
const MAX_MODEL_OR_PROVIDER_UTF8_BYTES = 2_048;
const MAX_SUDO_PASSWORD_CHARACTERS = 4_096;
const MAX_SUDO_PASSWORD_UTF8_BYTES = 16_384;
const MAX_SECRET_VALUE_CHARACTERS = 65_536;
const MAX_SECRET_VALUE_UTF8_BYTES = 262_144;
const SESSION_CREATE_RESULT_KEYS = new Set([
  "session_id",
  "stored_session_id",
  "message_count",
  "messages",
  "info",
]);
const SESSION_RESUME_RESULT_KEYS = new Set([
  "session_id",
  "resumed",
  "message_count",
  "messages",
  "info",
  "inflight",
  "running",
  "session_key",
  "started_at",
  "status",
]);
const SENSITIVE_RESPOND_RESULT_KEYS = new Set(["status"]);

const REQUEST_KEYS: Readonly<Record<HermesGatewayRequestMethod, ReadonlySet<string>>> = {
  "session.create": new Set(["cwd", "source", "model", "provider", "close_on_disconnect"]),
  "session.resume": new Set(["session_id"]),
  "prompt.submit": new Set(["session_id", "text"]),
  "session.interrupt": new Set(["session_id"]),
  "session.close": new Set(["session_id"]),
  "session.status": new Set(["session_id"]),
  "approval.respond": new Set(["session_id", "choice"]),
  "sudo.respond": new Set(["request_id", "password"]),
  "secret.respond": new Set(["request_id", "value"]),
};

const REQUEST_VALIDATORS: Readonly<Record<HermesGatewayRequestMethod, Validator>> = {
  "session.create": (value) =>
    isRecord(value) &&
    isValidAbsoluteCwd(value.cwd) &&
    value.source === "opentrad" &&
    isBoundedNonNulUnicodeString(
      value.model,
      MAX_MODEL_OR_PROVIDER_CHARACTERS,
      MAX_MODEL_OR_PROVIDER_UTF8_BYTES,
      true,
    ) &&
    isBoundedNonNulUnicodeString(
      value.provider,
      MAX_MODEL_OR_PROVIDER_CHARACTERS,
      MAX_MODEL_OR_PROVIDER_UTF8_BYTES,
      true,
    ) &&
    value.close_on_disconnect === false,
  "session.resume": (value) => isRecord(value) && isStoredSessionId(value.session_id),
  "prompt.submit": (value) =>
    isRecord(value) && isLiveSessionId(value.session_id) && isValidPromptText(value.text),
  "session.interrupt": hasLiveSessionId,
  "session.close": hasLiveSessionId,
  "session.status": hasLiveSessionId,
  "approval.respond": (value) =>
    isRecord(value) &&
    isLiveSessionId(value.session_id) &&
    (value.choice === "once" ||
      value.choice === "session" ||
      value.choice === "always" ||
      value.choice === "deny"),
  "sudo.respond": (value) =>
    isRecord(value) &&
    isPromptRequestId(value.request_id) &&
    isEmptyOrBoundedNonNulUnicodeString(
      value.password,
      MAX_SUDO_PASSWORD_CHARACTERS,
      MAX_SUDO_PASSWORD_UTF8_BYTES,
    ),
  "secret.respond": (value) =>
    isRecord(value) &&
    isPromptRequestId(value.request_id) &&
    isEmptyOrBoundedNonNulUnicodeString(
      value.value,
      MAX_SECRET_VALUE_CHARACTERS,
      MAX_SECRET_VALUE_UTF8_BYTES,
    ),
};

const RESULT_VALIDATORS: Readonly<Record<HermesGatewayRequestMethod, Validator>> = {
  "session.create": (value) =>
    isRecord(value) &&
    hasExactlyKeys(value, SESSION_CREATE_RESULT_KEYS) &&
    isLiveSessionId(value.session_id) &&
    isStoredSessionId(value.stored_session_id) &&
    isNonNegativeInteger(value.message_count) &&
    Array.isArray(value.messages) &&
    value.messages.length === value.message_count &&
    isRecord(value.info),
  "session.resume": (value) =>
    isRecord(value) &&
    hasOnlyKeys(value, SESSION_RESUME_RESULT_KEYS) &&
    isLiveSessionId(value.session_id) &&
    isStoredSessionId(value.resumed) &&
    isNonNegativeInteger(value.message_count) &&
    Array.isArray(value.messages) &&
    isRecord(value.info) &&
    typeof value.running === "boolean" &&
    isStoredSessionId(value.session_key) &&
    value.session_key === value.resumed &&
    typeof value.started_at === "number" &&
    Number.isFinite(value.started_at) &&
    value.started_at >= 0 &&
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
  "sudo.respond": isSensitiveRespondResult,
  "secret.respond": isSensitiveRespondResult,
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

function hasExactlyKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
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

function isPromptRequestId(value: unknown): value is string {
  return isLiveSessionId(value);
}

function isValidPromptText(value: unknown): value is string {
  return isBoundedUnicodeString(value, MAX_PROMPT_CHARACTERS, MAX_PROMPT_UTF8_BYTES, true);
}

function isValidAbsoluteCwd(value: unknown): value is string {
  return (
    isBoundedNonNulUnicodeString(value, MAX_CWD_CHARACTERS, MAX_CWD_UTF8_BYTES, true) &&
    isAbsolute(value)
  );
}

function isSensitiveRespondResult(value: unknown): boolean {
  return (
    isRecord(value) && hasExactlyKeys(value, SENSITIVE_RESPOND_RESULT_KEYS) && value.status === "ok"
  );
}

function isBoundedNonNulUnicodeString(
  value: unknown,
  maxCharacters: number,
  maxUtf8Bytes: number,
  requireNonWhitespace: boolean,
): value is string {
  return (
    isBoundedUnicodeString(value, maxCharacters, maxUtf8Bytes, requireNonWhitespace) &&
    !value.includes("\0")
  );
}

function isEmptyOrBoundedNonNulUnicodeString(
  value: unknown,
  maxCharacters: number,
  maxUtf8Bytes: number,
): value is string {
  return value === "" || isBoundedNonNulUnicodeString(value, maxCharacters, maxUtf8Bytes, false);
}

function isBoundedUnicodeString(
  value: unknown,
  maxCharacters: number,
  maxUtf8Bytes: number,
  requireNonWhitespace: boolean,
): value is string {
  if (typeof value !== "string" || value.length === 0) return false;

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
    if (characters > maxCharacters) return false;
    utf8Bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (utf8Bytes > maxUtf8Bytes) return false;
    if (!isPythonWhitespace(codePoint)) hasNonWhitespace = true;
  }
  return !requireNonWhitespace || hasNonWhitespace;
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

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
