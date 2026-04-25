// MockRiskGate 测试(M1 #27 占位实现)。
// 真 RiskGate(走 IPC bridge 弹窗)在 M1 #28 落地,届时同 interface 替换。

import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRiskGate } from "../src/risk-gate";

describe("MockRiskGate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requestApproval 永远 allow", async () => {
    const gate = new MockRiskGate();
    const result = await gate.requestApproval({
      sessionId: "s1",
      toolName: "browser_open",
      params: { url: "https://example.com/" },
    });
    expect(result.allowed).toBe(true);
  });

  it("写一行 stderr 诊断(便于 dev 模式定位 mock 在生效)", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const gate = new MockRiskGate();
    await gate.requestApproval({
      sessionId: "s2",
      toolName: "browser_read",
      params: { pageId: "p" },
    });
    expect(writeSpy).toHaveBeenCalled();
    const calls = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(calls).toContain("MockRiskGate auto-allow");
    expect(calls).toContain("browser_read");
    expect(calls).toContain("s2");
  });
});
