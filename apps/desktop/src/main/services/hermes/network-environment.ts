import { execFileSync } from "node:child_process";
import { isIP } from "node:net";

export const HERMES_LOOPBACK_NO_PROXY = "localhost,127.0.0.1,::1";

export type HermesNetworkEnvironment = Readonly<
  Partial<Record<"HTTP_PROXY" | "HTTPS_PROXY" | "NO_PROXY", string>>
>;

export interface HermesNetworkEnvironmentResolverOptions {
  readonly platform?: NodeJS.Platform;
  readonly readSystemProxy?: () => string;
}

const EMPTY_NETWORK_ENVIRONMENT: HermesNetworkEnvironment = Object.freeze({});
const MAX_SCUTIL_OUTPUT_BYTES = 65_536;
const SCUTIL_TIMEOUT_MS = 2_000;
const FIELD_PATTERN =
  /^\s*(HTTPEnable|HTTPPort|HTTPProxy|HTTPSEnable|HTTPSPort|HTTPSProxy)\s*:\s*(.*?)\s*$/u;
const HOST_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const PROXY_URL_PATTERN = /^http:\/\/(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/u;
const NETWORK_KEYS = new Set(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]);

type ProxyField =
  | "HTTPEnable"
  | "HTTPPort"
  | "HTTPProxy"
  | "HTTPSEnable"
  | "HTTPSPort"
  | "HTTPSProxy";

export function resolveHermesNetworkEnvironment(
  options: HermesNetworkEnvironmentResolverOptions = {},
): HermesNetworkEnvironment {
  if ((options.platform ?? process.platform) !== "darwin") return EMPTY_NETWORK_ENVIRONMENT;
  try {
    return parseMacOSSystemProxy((options.readSystemProxy ?? readMacOSSystemProxy)());
  } catch {
    return EMPTY_NETWORK_ENVIRONMENT;
  }
}

export function parseMacOSSystemProxy(output: unknown): HermesNetworkEnvironment {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > MAX_SCUTIL_OUTPUT_BYTES) {
    return EMPTY_NETWORK_ENVIRONMENT;
  }
  const fields: Partial<Record<ProxyField, string>> = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = FIELD_PATTERN.exec(line);
    if (!match) continue;
    const key = match[1] as ProxyField;
    if (Object.hasOwn(fields, key)) return EMPTY_NETWORK_ENVIRONMENT;
    fields[key] = match[2];
  }

  const http = proxyUrl(fields, "HTTP");
  const https = proxyUrl(fields, "HTTPS");
  if (http === null || https === null) return EMPTY_NETWORK_ENVIRONMENT;

  const environment: Record<string, string> = {};
  if (http) environment.HTTP_PROXY = http;
  if (https) environment.HTTPS_PROXY = https;
  if (http || https) environment.NO_PROXY = HERMES_LOOPBACK_NO_PROXY;
  return Object.freeze(environment);
}

export function snapshotHermesNetworkEnvironment(value: unknown): HermesNetworkEnvironment {
  if (value === undefined) return EMPTY_NETWORK_ENVIRONMENT;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalidNetworkEnvironment();
  const snapshot: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!NETWORK_KEYS.has(key) || typeof entry !== "string") throw invalidNetworkEnvironment();
    if (key === "NO_PROXY") {
      if (entry !== HERMES_LOOPBACK_NO_PROXY) throw invalidNetworkEnvironment();
    } else if (!isValidProxyUrl(entry)) {
      throw invalidNetworkEnvironment();
    }
    snapshot[key] = entry;
  }
  const hasProxy = snapshot.HTTP_PROXY !== undefined || snapshot.HTTPS_PROXY !== undefined;
  if (hasProxy !== (snapshot.NO_PROXY !== undefined)) throw invalidNetworkEnvironment();
  return Object.freeze(snapshot);
}

export function isValidHermesProxyUrl(value: unknown): value is string {
  return typeof value === "string" && isValidProxyUrl(value);
}

function readMacOSSystemProxy(): string {
  return execFileSync("/usr/sbin/scutil", ["--proxy"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: MAX_SCUTIL_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: SCUTIL_TIMEOUT_MS,
  });
}

function proxyUrl(
  fields: Partial<Record<ProxyField, string>>,
  prefix: "HTTP" | "HTTPS",
): string | null | undefined {
  const enabled = fields[`${prefix}Enable`];
  if (enabled === undefined || enabled === "0") return undefined;
  if (enabled !== "1") return null;
  const host = normalizeProxyHost(fields[`${prefix}Proxy`]);
  const port = normalizeProxyPort(fields[`${prefix}Port`]);
  if (!host || !port) return null;
  return `http://${host}:${port}`;
}

function normalizeProxyHost(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) return undefined;
  if (value !== value.trim() || /[\s\0\r\n/@\\?#%]/u.test(value)) return undefined;
  const ipVersion = isIP(value);
  if (ipVersion === 4) return value;
  if (ipVersion === 6) return `[${value}]`;
  const labels = value.split(".");
  if (labels.some((label) => !HOST_LABEL_PATTERN.test(label))) return undefined;
  return value.toLowerCase();
}

function normalizeProxyPort(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[0-9]{1,5}$/u.test(value)) return undefined;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? String(port) : undefined;
}

function isValidProxyUrl(value: string): boolean {
  const match = PROXY_URL_PATTERN.exec(value);
  if (!match) return false;
  const rawHost = match[1];
  const rawPort = match[2];
  if (!rawHost || !rawPort) return false;
  const host = rawHost.startsWith("[") ? rawHost.slice(1, -1) : rawHost;
  return normalizeProxyHost(host) === rawHost && normalizeProxyPort(rawPort) === rawPort;
}

function invalidNetworkEnvironment(): Error {
  return new Error("Hermes network environment is invalid");
}
