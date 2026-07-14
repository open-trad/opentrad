import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
const ipcSource = readFileSync(new URL("../src/main/ipc/index.ts", import.meta.url), "utf8");

describe("desktop Hermes network wiring", () => {
  it("resolves one trusted system-proxy snapshot and shares it with inference and OAuth", () => {
    expect(mainSource).toContain("resolveHermesNetworkEnvironment");
    expect(mainSource).toContain("const hermesNetworkEnvironment =");
    expect(mainSource).toContain("networkEnvironment: hermesNetworkEnvironment");
    expect(mainSource).toContain("hermesNetworkEnvironment,");
    expect(mainSource).toContain("...hermesNetworkEnvironment");
    expect(ipcSource).toContain("networkEnvironment: deps.hermesNetworkEnvironment");
  });
});
