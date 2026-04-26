// electron-vite 配置：三入口（main/preload/renderer）。
// 开发阶段 `pnpm dev` 启动 electron-vite dev server；构建输出到 ./out/。
// M0 范围：只要能启动窗口、渲染 React 页面、跑通 IPC 事件流。

import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// @opentrad/* 是 workspace 源码 TS，未 build。externalizeDepsPlugin 默认
// 把所有 dependencies 当 external，会让 main/preload 在 Node 运行时按
// ESM 规则 resolve，找不到 `.ts` 扩展名报 ERR_MODULE_NOT_FOUND。
// 把 @opentrad/* 排除（即一起 bundle）避开此问题。
//
// **dev-time bug 教训**(M1 收尾发起人 dev 起不来):新加 workspace dep 时必须
// 同步加进本 list,否则 main 进程 ESM resolve 时报 ERR_MODULE_NOT_FOUND。
// retrospective followup #9 加 dev-smoke job 治本(三平台 fresh checkout 起 main
// bundle 5 秒,挡这种"CI 绿但 dev 死"盲区)。
const OPENTRAD_WORKSPACE_DEPS = [
  "@opentrad/shared",
  "@opentrad/stream-parser",
  "@opentrad/cc-adapter",
  "@opentrad/skill-runtime", // M1 #23 加,#43 切换 PR 时漏加
  "@opentrad/risk-gate", // M1 #28 阶段 2 加,漏加
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
