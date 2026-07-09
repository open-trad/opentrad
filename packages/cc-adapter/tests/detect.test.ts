// detect.test.ts — 通过替换 binary 为真实系统命令（如 `echo` / `false`）
// 来验证 detectInstallation 的 parse 和错误分支，不 mock child_process。
// 这样测试更贴近生产行为（execFile 真跑子进程）。

import { describe, expect, it } from "vitest";
import { detectInstallation } from "../src";

describe("detectInstallation", () => {
  it("returns not-installed for missing binary (ENOENT)", async () => {
    const res = await detectInstallation("/tmp/__opentrad_cc_adapter_nonexistent_bin__");
    expect(res.installed).toBe(false);
    expect(res.error).toMatch(/not found|ENOENT/);
  });

  it("parses version from a fake echo binary emitting CC-style output", async () => {
    // 用 `node -e` 模拟 CC --version 输出
    const res = await detectInstallation("node");
    // node --version 的输出是 "vX.Y.Z"（有 v 前缀），和 CC 正则不匹配 → unparsable
    // 但它会是 installed=false + unparsable error
    expect(res.installed).toBe(false);
    expect(res.error).toMatch(/unparsable/);
  });
});
