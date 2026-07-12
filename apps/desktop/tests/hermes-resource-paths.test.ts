import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  HERMES_LAUNCHER_FILENAME,
  resolveHermesLauncherPath,
} from "../src/main/services/hermes/resource-paths";

describe("resolveHermesLauncherPath", () => {
  it("resolves the source resource in desktop development", () => {
    expect(
      resolveHermesLauncherPath(
        {
          appPath: "/Users/example/opentrad/apps/desktop",
          mode: "development",
        },
        "darwin",
      ),
    ).toBe("/Users/example/opentrad/apps/desktop/resources/hermes/opentrad_hermes_launcher.py");
  });

  it("resolves the extraResources copy in a packaged app", () => {
    expect(
      resolveHermesLauncherPath(
        {
          mode: "packaged",
          resourcesPath: "/Applications/OpenTrad.app/Contents/Resources",
        },
        "darwin",
      ),
    ).toBe("/Applications/OpenTrad.app/Contents/Resources/hermes/opentrad_hermes_launcher.py");
  });

  it("uses the injected platform path implementation without reading Electron globals", () => {
    expect(HERMES_LAUNCHER_FILENAME).toBe("opentrad_hermes_launcher.py");
    expect(
      resolveHermesLauncherPath(
        {
          appPath: "C:\\OpenTrad\\app",
          mode: "development",
        },
        "win32",
      ),
    ).toBe(win32.join("C:\\OpenTrad\\app", "resources", "hermes", HERMES_LAUNCHER_FILENAME));
  });

  it("rejects relative and malformed Electron path snapshots", () => {
    const valid = {
      appPath: "/Users/example/opentrad/apps/desktop",
      mode: "development",
    } as const;

    expect(() =>
      resolveHermesLauncherPath({ ...valid, appPath: "apps/desktop" }, "darwin"),
    ).toThrowError(/Hermes resource path is invalid/);
    expect(() =>
      resolveHermesLauncherPath({ mode: "packaged", resourcesPath: "Resources" }, "darwin"),
    ).toThrowError(/Hermes resource path is invalid/);
    expect(posix.isAbsolute(resolveHermesLauncherPath(valid, "darwin"))).toBe(true);
  });

  it("reads only the root selected by the discriminated location mode", () => {
    const development = {
      mode: "development",
      appPath: "/Users/example/opentrad/apps/desktop",
    } as Record<string, unknown>;
    Object.defineProperty(development, "resourcesPath", {
      get: () => {
        throw new Error("unused packaged root canary");
      },
    });
    const packaged = {
      mode: "packaged",
      resourcesPath: "/Applications/OpenTrad.app/Contents/Resources",
    } as Record<string, unknown>;
    Object.defineProperty(packaged, "appPath", {
      get: () => {
        throw new Error("unused development root canary");
      },
    });

    expect(() =>
      resolveHermesLauncherPath(
        development as unknown as Parameters<typeof resolveHermesLauncherPath>[0],
        "darwin",
      ),
    ).not.toThrow();
    expect(() =>
      resolveHermesLauncherPath(
        packaged as unknown as Parameters<typeof resolveHermesLauncherPath>[0],
        "darwin",
      ),
    ).not.toThrow();
  });

  it("packages only the launcher and its hash-pinned sibling outside app.asar", () => {
    const config = load(
      readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"),
    ) as {
      extraResources?: unknown;
    };

    expect(config.extraResources).toEqual([
      {
        from: "resources/hermes",
        to: "hermes",
        filter: ["opentrad_hermes_launcher.py", "opentrad_hermes_runtime.py"],
      },
    ]);
  });
});
