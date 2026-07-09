import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // electron API 在 vitest 进程里不可 import；只测纯 Node 模块（db services / lock / paths）。
    // IPC handler 单测需要 mock electron，目前不在 M1 #19 scope。
  },
});
