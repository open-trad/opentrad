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

// IPC bridge socket / named pipe（M1 #25）。
// macOS / Linux：~/.opentrad/ipc.sock（Unix domain socket）
// Windows：\\.\pipe\opentrad-ipc（named pipe，不在文件系统）
export function getIpcSocketPath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\opentrad-ipc";
  }
  return join(getUserDataDir(), "ipc.sock");
}

// skill 生成的草稿目录（M1 #25 draft.save RPC + 后续 M1 #26 / #9 用）。
// 不需要 Windows 特殊处理 —— %APPDATA%\OpenTrad\drafts 也合理。
export function getDraftsDir(): string {
  return join(getUserDataDir(), "drafts");
}
