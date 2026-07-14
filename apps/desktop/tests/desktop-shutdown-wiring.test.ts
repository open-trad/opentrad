import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");

describe("desktop shutdown wiring", () => {
  it("leaves process signal handling to the desktop shutdown coordinator", () => {
    expect(source).toContain("new CCManager({ installExitHandlers: false })");
    expect(source).toContain('process.once("SIGINT"');
    expect(source).toContain('process.once("SIGTERM"');
  });

  it("routes window close and before-quit through the same coordinator", () => {
    expect(source).toContain('win.on("close"');
    expect(source).toContain('requestShutdown("window-close")');
    expect(source).toContain('app.on("before-quit"');
    expect(source).toContain('requestShutdown("before-quit")');
  });

  it("guards both window creation and activation once quitting starts", () => {
    const createWindowSource = source.slice(
      source.indexOf("function createMainWindow"),
      source.indexOf("function resolveSkillContext"),
    );
    const activateSource = source.slice(
      source.indexOf('app.on("activate"'),
      source.indexOf("// 非 macOS"),
    );

    expect(createWindowSource).toContain("shutdownCoordinator.canCreateMainWindow()");
    expect(activateSource).toContain("shutdownCoordinator.canCreateMainWindow()");
  });
});
