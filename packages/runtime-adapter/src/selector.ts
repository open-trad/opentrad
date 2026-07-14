import type { RuntimeKind } from "./types";

export interface RuntimeSelectionInput {
  envRuntime?: unknown;
  persistedPreference?: unknown;
}

export function selectRuntimeKind(input: RuntimeSelectionInput): RuntimeKind {
  // Hermes is the product path. Only the exact emergency kill switch may select legacy;
  // stale preferences and malformed environment values must not silently downgrade runtime.
  return input.envRuntime === "legacy" ? "legacy" : "hermes";
}
