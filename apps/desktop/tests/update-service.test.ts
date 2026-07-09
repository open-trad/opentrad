import { describe, expect, it } from "vitest";
import { compareSemver } from "../src/main/services/update-service";

describe("compareSemver", () => {
  it("比较主次修订", () => {
    expect(compareSemver("0.2.0", "0.1.0")).toBe(1);
    expect(compareSemver("0.1.0", "0.2.0")).toBe(-1);
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
    expect(compareSemver("0.1.1", "0.1.0")).toBe(1);
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
  });

  it("容忍 v 前缀与缺位", () => {
    expect(compareSemver("v0.2.0", "0.1.0")).toBe(1);
    expect(compareSemver("v0.1.0", "v0.1.0")).toBe(0);
    expect(compareSemver("0.2", "0.1.5")).toBe(1);
  });
});
