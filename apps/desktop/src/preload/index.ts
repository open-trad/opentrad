// Preload 脚本：contextBridge 暴露 typed IPC API 给 renderer。
// 对应 03-architecture.md §2 apps/desktop/src/main/preload.ts。
//
// M0 范围：框架占位，暴露一个空 api 对象让 renderer 能 import 不报错。
// Issue #7（IPC 通信）里补全实际 channel（cc/skill/session/settings）。

import { contextBridge } from "electron";

// M0 占位 API。Issue #7 会把各 channel 的 invoke 方法填进来。
const api = {
  // IPC 方法待 Issue #7 实现
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("api", api);
  } catch (err) {
    console.error("[preload] contextBridge exposeInMainWorld failed", err);
  }
} else {
  // contextIsolation 被关闭时的降级（生产不走这里）
  // @ts-expect-error — 直接挂 window 的非标准用法仅限开发降级
  window.api = api;
}

export type OpenTradApi = typeof api;
