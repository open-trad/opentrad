// installer.ts 测试：平台分支 + 自动安装命令组装。
// 用 vi.stubGlobal 改 process.platform 模拟三平台行为（A3 决策实现验证）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { getAutoInstallCommand, getPlatformInstallSupport } from "../src/main/services/installer";

describe("getPlatformInstallSupport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("macOS 支持自动安装", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const support = getPlatformInstallSupport();
    expect(support.platform).toBe("darwin");
    expect(support.supportsAutoInstall).toBe(true);
    expect(support.manualInstallUrl).toContain("docs.claude.com");
  });

  it("Linux 支持自动安装", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(getPlatformInstallSupport().supportsAutoInstall).toBe(true);
  });

  it("Windows 不支持自动安装(A3 降级)", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const support = getPlatformInstallSupport();
    expect(support.platform).toBe("win32");
    expect(support.supportsAutoInstall).toBe(false);
    expect(support.manualInstallUrl).toContain("docs.claude.com");
  });

  it("其他未知平台降级到 other / 不支持", () => {
    Object.defineProperty(process, "platform", { value: "freebsd", configurable: true });
    const support = getPlatformInstallSupport();
    expect(support.platform).toBe("other");
    expect(support.supportsAutoInstall).toBe(false);
  });
});

describe("getAutoInstallCommand", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("macOS / Linux 返回 bash -c 命令调 install.sh", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    const cmd = getAutoInstallCommand();
    expect(cmd.command).toBe("/bin/bash");
    expect(cmd.args).toEqual(["-c", "curl -fsSL https://claude.ai/install.sh | bash"]);
  });

  it("Windows 抛错(防御性,实际 caller 应先用 supportsAutoInstall 守门)", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(() => getAutoInstallCommand()).toThrow(/not supported/);
  });
});
