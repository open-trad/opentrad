import { posix, win32 } from "node:path";
import type { HermesPlatform } from "./paths";

export const HERMES_LAUNCHER_FILENAME = "opentrad_hermes_launcher.py";

export type HermesLauncherLocation =
  | {
      readonly mode: "development";
      readonly appPath: string;
    }
  | {
      readonly mode: "packaged";
      readonly resourcesPath: string;
    };

export class HermesResourcePathError extends Error {
  readonly code = "HERMES_RESOURCE_PATH";

  constructor() {
    super("Hermes resource path is invalid");
    this.name = "HermesResourcePathError";
  }
}

export function resolveHermesLauncherPath(
  location: HermesLauncherLocation,
  platform: HermesPlatform,
): string {
  try {
    const path = platform === "win32" ? win32 : posix;
    const root = location.mode === "packaged" ? location.resourcesPath : location.appPath;
    if (typeof root !== "string" || !path.isAbsolute(root)) {
      throw new HermesResourcePathError();
    }
    return location.mode === "packaged"
      ? path.join(root, "hermes", HERMES_LAUNCHER_FILENAME)
      : path.join(root, "resources", "hermes", HERMES_LAUNCHER_FILENAME);
  } catch (cause) {
    if (cause instanceof HermesResourcePathError) throw cause;
    throw new HermesResourcePathError();
  }
}
