// @opentrad/cc-adapter 入口：导出 CCManager + 相关类型。
// 对应 03-architecture.md §4.1 Process Manager 模块。

export type { AuthStatus } from "./auth";
export { getAuthStatus, parseAuthStatus, redactEmail } from "./auth";
export type { DetectInstallationResult } from "./detect";
export { detectInstallation } from "./detect";
export type { CCChildProcess, CCTaskHandleInit } from "./handle";
export { CCTaskHandleImpl } from "./handle";
export type { CCManagerOptions } from "./manager";
export { buildClaudeArgs, CCManager } from "./manager";
