// 跨平台用户数据目录定位。
// macOS / Linux：~/.opentrad/
// Windows：%APPDATA%\OpenTrad\

import { homedir } from "node:os";
import { join } from "node:path";

export function getUserDataDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "OpenTrad");
  }
  return join(homedir(), ".opentrad");
}

export function getDbPath(): string {
  return join(getUserDataDir(), "opentrad.db");
}

export function getLockPath(): string {
  return join(getUserDataDir(), ".lock");
}
