import type { RuntimeKind } from "./types";

export interface RuntimeSelectionInput {
  envRuntime?: unknown;
  persistedPreference?: unknown;
}

export function selectRuntimeKind(input: RuntimeSelectionInput): RuntimeKind {
  if (input.envRuntime !== undefined) {
    return input.envRuntime === "hermes" ? "hermes" : "legacy";
  }
  return input.persistedPreference === "hermes" ? "hermes" : "legacy";
}
