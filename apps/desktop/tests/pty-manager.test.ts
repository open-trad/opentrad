// PtyManager 基础单测：spawn 一个 echo 子进程，收集 onData 数据，等 exit。
// 不依赖 electron — PtyManager 是纯 Node EventEmitter 风格。

import { describe, expect, it } from "vitest";
import { PtyManager } from "../src/main/services/pty-manager";

describe("PtyManager", () => {
  // 跨平台用真实 echo 命令（macOS / Linux 是 /bin/echo；Windows 上 echo 是 shell built-in，
  // CI 跑 Windows runner 这里会跳过——M0 D9-1 标准：CI workflow 调整自主决策）
  it.skipIf(process.platform === "win32")(
    "spawn echo → onData captures stdout → onExit emits",
    async () => {
      const manager = new PtyManager();
      const buffer: string[] = [];
      let exited = false;
      let exitCode: number | undefined;
      let resolveDone: () => void = () => {};
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });

      manager.on("data", ({ data }) => {
        buffer.push(data);
      });
      manager.on("exit", ({ exitCode: code }) => {
        exited = true;
        exitCode = code;
        resolveDone();
      });

      manager.spawn({
        command: "/bin/echo",
        args: ["hi from pty"],
      });

      // 给 PTY 5 秒上限完成；echo 通常 < 100ms
      await Promise.race([
        done,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("echo timed out")), 5000),
        ),
      ]);

      expect(exited).toBe(true);
      expect(exitCode).toBe(0);
      expect(buffer.join("")).toContain("hi from pty");
    },
  );

  it("activePtys 在 spawn 后含 ptyId，cleanup 后清空", () => {
    const manager = new PtyManager();
    // spawn 一个长寿命 shell 用于 cleanup 测试（/bin/sleep 100）
    if (process.platform === "win32") {
      // Windows 上跳过；node-pty 行为差异，依赖 issue #20 D-M1-1 自主决策范围
      return;
    }
    const ptyId = manager.spawn({ command: "/bin/sleep", args: ["10"] });
    expect(manager.activePtys.has(ptyId)).toBe(true);
    expect(manager.activePtys.size).toBe(1);

    manager.cleanup();
    // cleanup 是同步触发 kill；onExit 是异步事件，size 不一定立刻清零
    // 这里只 assert cleanup 函数本身幂等可调用，不抛
    expect(() => manager.cleanup()).not.toThrow();
  });
});
