import { describe, expect, it } from "vitest";
import {
  RiskGateDecisionSchema,
  RiskGateRequestSchema,
  RiskGateResponsePayloadSchema,
} from "../src";

describe("RiskGateRequest schema", () => {
  it("parses a minimal review-level request", () => {
    const raw = {
      skillId: "supplier-rfq-draft",
      toolName: "browser_open",
      params: { url: "https://1688.com" },
      riskLevel: "review",
    };
    expect(RiskGateRequestSchema.safeParse(raw).success).toBe(true);
  });

  it("parses a business-level request with stopBefore action", () => {
    const raw = {
      skillId: "supplier-rfq-draft",
      toolName: "send_rfq",
      params: { to: "abc@supplier.com" },
      riskLevel: "review",
      businessAction: "send_rfq",
    };
    expect(RiskGateRequestSchema.safeParse(raw).success).toBe(true);
  });

  it("rejects invalid riskLevel", () => {
    const raw = {
      skillId: "x",
      toolName: "x",
      params: {},
      riskLevel: "medium",
    };
    expect(RiskGateRequestSchema.safeParse(raw).success).toBe(false);
  });
});

describe("RiskGateDecision schema", () => {
  it("accepts all five decision values", () => {
    for (const decision of [
      "allow",
      "deny",
      "allow_once",
      "allow_session",
      "allow_always",
    ] as const) {
      expect(
        RiskGateDecisionSchema.safeParse({
          decision,
          timestamp: Date.now(),
        }).success,
      ).toBe(true);
    }
  });

  it("accepts allow_session from the renderer response", () => {
    expect(
      RiskGateResponsePayloadSchema.parse({
        requestId: "request-1",
        kind: "allow_session",
      }),
    ).toEqual({ requestId: "request-1", kind: "allow_session" });
  });

  it("rejects non-integer timestamp", () => {
    expect(
      RiskGateDecisionSchema.safeParse({
        decision: "allow",
        timestamp: 1.5,
      }).success,
    ).toBe(false);
  });
});
