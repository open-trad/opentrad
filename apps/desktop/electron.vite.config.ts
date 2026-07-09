// electron-vite 配置：三入口（main/preload/renderer）。
// 开发阶段 `pnpm dev` 启动 electron-vite dev server；构建输出到 ./out/。
// M0 范围：只要能启动窗口、渲染 React 页面、跑通 IPC 事件流。

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// @opentrad/* 是 workspace 源码 TS，未 build。externalizeDepsPlugin 默认
// 把所有 dependencies 当 external，会让 main/preload 在 Node 运行时按
// ESM 规则 resolve，找不到 `.ts` 扩展名报 ERR_MODULE_NOT_FOUND。
// 把 @opentrad/* 排除（即一起 bundle）避开此问题。
const OPENTRAD_WORKSPACE_DEPS = [
  "@opentrad/shared",
  "@opentrad/stream-parser",
  "@opentrad/cc-adapter",
];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: OPENTRAD_WORKSPACE_DEPS })],
    build: {
      outDir: "out/main",
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: OPENTRAD_WORKSPACE_DEPS })],
    build: {
      outDir: "out/preload",
    },
  },
  renderer: {
    build: {
      outDir: "out/renderer",
    },
    plugins: [react()],
  },
});
