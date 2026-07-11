import { describe, expect, it } from "vitest";
import { selectRuntimeKind } from "../src/selector";

describe("selectRuntimeKind", () => {
  it("defaults to legacy when no runtime is configured", () => {
    expect(selectRuntimeKind({})).toBe("legacy");
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

  it("falls back to legacy for an invalid environment value", () => {
    expect(selectRuntimeKind({ envRuntime: "experimental", persistedPreference: "hermes" })).toBe(
      "legacy",
    );
  });

  it("treats a null environment value as invalid instead of consulting persisted hermes", () => {
    expect(selectRuntimeKind({ envRuntime: null, persistedPreference: "hermes" })).toBe("legacy");
  });

  it("falls back to legacy for an invalid persisted preference", () => {
    expect(selectRuntimeKind({ persistedPreference: "experimental" })).toBe("legacy");
  });

  it("uses only injected input and does not read or mutate process.env", () => {
    const previous = process.env.OPENTRAD_RUNTIME;
    process.env.OPENTRAD_RUNTIME = "hermes";
    try {
      expect(selectRuntimeKind({})).toBe("legacy");
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
