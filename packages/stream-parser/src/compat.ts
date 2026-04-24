// CC 版本兼容矩阵。
// kickoff A1 决策：实测版本 2.1.119 作为基线；不硬抄旧的 2.1.0 起点列表。
// 策略：按 major.minor 定兼容档；patch 级差异通过 wire schema 的 .passthrough() 吸收。

export type CompatStatus =
  | { supported: true }
  | { supported: "experimental"; reason: string }
  | { supported: false; reason: string };

// 基线版本（实测） — 用于冷启动日志和未定义 minor 的默认兜底参考。
export const BASELINE_VERSION = "2.1.119";

// major.minor → 档位
const COMPAT_MATRIX: Record<string, CompatStatus> = {
  "2.0": {
    supported: false,
    reason: "CC 2.0.x missing --mcp-config and --strict-mcp-config flags",
  },
  "2.1": { supported: true },
  "2.2": {
    supported: "experimental",
    reason: "CC 2.2.x schema not yet verified against OpenTrad",
  },
};

// 从版本字符串提取 major.minor（如 "2.1.119" → "2.1"）。
function toMinor(version: string): string | null {
  const parts = version.split(".");
  if (parts.length < 2) return null;
  return `${parts[0]}.${parts[1]}`;
}

export function checkCompatibility(version: string): CompatStatus {
  const minor = toMinor(version);
  if (!minor) {
    return { supported: false, reason: `invalid version string: ${version}` };
  }
  const status = COMPAT_MATRIX[minor];
  if (status) return status;
  return {
    supported: "experimental",
    reason: `CC ${minor}.x not in compatibility matrix (baseline is ${BASELINE_VERSION})`,
  };
}
