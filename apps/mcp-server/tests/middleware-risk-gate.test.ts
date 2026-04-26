// runRiskGate middleware 测试(M1 #28 阶段 2)。
//
// 验证 3 种 riskLevel 行为 + bridge 错误 graceful degrade。
// fake bridge / fake tool 注入,不真起 IPC bridge。

import { describe, expect, it, vi } from "vitest";
import type { IpcBridgeClient } from "../src/ipc-bridge";
import { runRiskGate } from "../src/middleware/risk-gate";
import type { OpenTradTool } from "../src/tools";

const baseTool = (overrides?: Partial<OpenTradTool>): OpenTradTool =>
  ({
    name: "browser_open",
    description: "test",
    inputSchema: {} as never,
    riskLevel: "review",
    category: "browser",
    execute: vi.fn(),
    ...overrides,
  }) as OpenTradTool;

function makeFakeBridge(impl?: Partial<IpcBridgeClient>): IpcBridgeClient {
  return impl as unknown as IpcBridgeClient;
}

describe("runRiskGate middleware", () => {
  it("blocked → 直接拒(local short-circuit,不走 bridge)", async () => {
    const riskGateRequest = vi.fn();
    const bridge = makeFakeBridge({ riskGateRequest });

    const decision = await runRiskGate({
      bridge,
      tool: baseTool({ riskLevel: "blocked" }),
      toolArgs: { url: "https://x" },
      sessionId: "s1",
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("blocked by risk policy");
    expect(riskGateRequest).not.toHaveBeenCalled();
  });

  it("safe → bypass(不走 bridge)", async () => {
    const riskGateRequest = vi.fn();
    const bridge = makeFakeBridge({ riskGateRequest });

    const decision = await runRiskGate({
      bridge,
      tool: baseTool({ name: "echo", riskLevel: "safe" }),
      toolArgs: {},
      sessionId: "s1",
    });

    expect(decision.allowed).toBe(true);
    expect(riskGateRequest).not.toHaveBeenCalled();
  });

  it("review + bridge allow → allowed", async () => {
    const riskGateRequest = vi.fn().mockResolvedValue({
      decision: "allow_once",
      timestamp: Date.now(),
    });
    const bridge = makeFakeBridge({ riskGateRequest });

    const decision = await runRiskGate({
      bridge,
      tool: baseTool(),
      toolArgs: { url: "https://x" },
      sessionId: "s1",
    });

    expect(decision.allowed).toBe(true);
    expect(riskGateRequest).toHaveBeenCalledWith({
      skillId: "",
      toolName: "browser_open",
      riskLevel: "review",
      params: { url: "https://x" },
    });
  });

  it("review + bridge allow_always → allowed", async () => {
    const riskGateRequest = vi.fn().mockResolvedValue({
      decision: "allow_always",
      timestamp: Date.now(),
    });
    const decision = await runRiskGate({
      bridge: makeFakeBridge({ riskGateRequest }),
      tool: baseTool(),
      toolArgs: {},
      sessionId: "s",
    });
    expect(decision.allowed).toBe(true);
  });

  it("review + bridge deny → not allowed,reason 透传", async () => {
    const riskGateRequest = vi.fn().mockResolvedValue({
      decision: "deny",
      reason: "user_dismissed",
      timestamp: Date.now(),
    });
    const decision = await runRiskGate({
      bridge: makeFakeBridge({ riskGateRequest }),
      tool: baseTool(),
      toolArgs: {},
      sessionId: "s",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("user_dismissed");
  });

  it("graceful degrade:bridge throw → deny + reason='middleware_error'", async () => {
    const riskGateRequest = vi.fn().mockRejectedValue(new Error("socket reset"));
    const decision = await runRiskGate({
      bridge: makeFakeBridge({ riskGateRequest }),
      tool: baseTool(),
      toolArgs: {},
      sessionId: "s",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("risk-gate middleware error");
    expect(decision.reason).toContain("socket reset");
  });
});
