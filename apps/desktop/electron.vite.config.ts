// electron-vite 配置：三入口（main/preload/renderer）。
// 开发阶段 `pnpm dev` 启动 electron-vite dev server；构建输出到 ./out/。
// M0 范围：只要能启动窗口、渲染 React 页面。electron-builder 打包留到 M1。

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
    },
  },
  preload: {
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
