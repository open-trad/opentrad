import { describe, expect, it } from "vitest";
import { BASELINE_VERSION, checkCompatibility } from "../src";

describe("BASELINE_VERSION", () => {
  it("is the version actually tested during Issue #4 kickoff", () => {
    expect(BASELINE_VERSION).toBe("2.1.119");
  });
});

describe("checkCompatibility", () => {
  it("accepts 2.1.x as supported", () => {
    expect(checkCompatibility("2.1.0")).toEqual({ supported: true });
    expect(checkCompatibility("2.1.119")).toEqual({ supported: true });
    expect(checkCompatibility("2.1.999")).toEqual({ supported: true });
  });

  it("marks 2.0.x as unsupported with reason", () => {
    const s = checkCompatibility("2.0.5");
    expect(s.supported).toBe(false);
    if (s.supported === false) expect(s.reason).toMatch(/mcp-config/i);
  });

  it("marks 2.2.x as experimental with reason", () => {
    const s = checkCompatibility("2.2.0");
    expect(s.supported).toBe("experimental");
    if (s.supported === "experimental") expect(s.reason).toBeTruthy();
  });

  it("marks unlisted minor as experimental with baseline reference", () => {
    const s = checkCompatibility("3.0.0");
    expect(s.supported).toBe("experimental");
    if (s.supported === "experimental") {
      expect(s.reason).toContain(BASELINE_VERSION);
    }
  });

  it("rejects invalid version strings", () => {
    const s = checkCompatibility("nonsense");
    expect(s.supported).toBe(false);
    if (s.supported === false) expect(s.reason).toMatch(/invalid/i);
  });
});
