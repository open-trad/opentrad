// Renderer 侧的 window.api 类型声明。
// preload 通过 contextBridge 挂 api 到 window；此处声明类型让 renderer 代码有完整类型提示。

import type { OpenTradApi } from "../../preload";

declare global {
  interface Window {
    api: OpenTradApi;
  }
}
