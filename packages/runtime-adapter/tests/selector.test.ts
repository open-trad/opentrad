import { describe, expect, it } from "vitest";
import { selectRuntimeKind } from "../src/selector";

describe("selectRuntimeKind", () => {
  it("defaults globally to Hermes", () => {
    expect(selectRuntimeKind({})).toBe("hermes");
  });

  it("selects hermes for an explicit persisted preference", () => {
    expect(selectRuntimeKind({ persistedPreference: "hermes" })).toBe("hermes");
  });

  it("selects hermes for an explicit environment opt-in", () => {
    expect(selectRuntimeKind({ envRuntime: "hermes" })).toBe("hermes");
  });

  it("lets the hermes environment opt-in override persisted legacy", () => {
    expect(selectRuntimeKind({ envRuntime: "hermes", persistedPreference: "legacy" })).toBe(
      "hermes",
    );
  });

  it("lets the legacy environment kill switch override persisted hermes", () => {
    expect(selectRuntimeKind({ envRuntime: "legacy", persistedPreference: "hermes" })).toBe(
      "legacy",
    );
  });

  it("does not silently downgrade for an invalid environment value", () => {
    expect(selectRuntimeKind({ envRuntime: "experimental", persistedPreference: "hermes" })).toBe(
      "hermes",
    );
  });

  it("treats a null environment value as absent", () => {
    expect(selectRuntimeKind({ envRuntime: null, persistedPreference: "legacy" })).toBe("hermes");
  });

  it("ignores stale persisted preferences", () => {
    expect(selectRuntimeKind({ persistedPreference: "legacy" })).toBe("hermes");
    expect(selectRuntimeKind({ persistedPreference: "experimental" })).toBe("hermes");
  });

  it("uses only injected input and does not read or mutate process.env", () => {
    const previous = process.env.OPENTRAD_RUNTIME;
    process.env.OPENTRAD_RUNTIME = "hermes";
    try {
      expect(selectRuntimeKind({})).toBe("hermes");
      expect(process.env.OPENTRAD_RUNTIME).toBe("hermes");
    } finally {
      if (previous === undefined) {
        delete process.env.OPENTRAD_RUNTIME;
      } else {
        process.env.OPENTRAD_RUNTIME = previous;
      }
    }
  });
});
