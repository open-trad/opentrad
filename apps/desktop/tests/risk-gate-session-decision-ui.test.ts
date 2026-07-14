import type { RiskGateConfirmPayload } from "@opentrad/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BusinessActionCard } from "../src/renderer/features/risk-gate/BusinessActionCard";
import { RiskGateDialog } from "../src/renderer/features/risk-gate/RiskGateDialog";

const payload: RiskGateConfirmPayload = {
  requestId: "request-1",
  sessionId: "session-1",
  skillId: "hermes-plugin",
  toolName: "terminal",
  riskLevel: "review",
  params: { command: "git status", pluginName: "official-plugin" },
  businessAction: null,
  category: "hermes-native",
};

describe("Risk Gate session approval UI", () => {
  it("offers a non-persistent session decision for tool-level approval", () => {
    const html = renderToStaticMarkup(
      createElement(RiskGateDialog, { payload, onDecide: () => {} }),
    );

    expect(html).toContain("允许一次");
    expect(html).toContain("本会话允许");
    expect(html).toContain("以后都允许");
    expect(html).toContain("受信代码");
  });

  it("offers the same session scope for business actions", () => {
    const html = renderToStaticMarkup(
      createElement(BusinessActionCard, {
        payload: { ...payload, businessAction: "submit_form" },
        onDecide: () => {},
      }),
    );

    expect(html).toContain("本会话允许");
    expect(html).toContain("受信代码");
  });

  it("does not label a core Hermes tool as plugin code", () => {
    const html = renderToStaticMarkup(
      createElement(RiskGateDialog, {
        payload: { ...payload, params: { command: "git status" } },
        onDecide: () => {},
      }),
    );

    expect(html).not.toContain("受信代码");
  });
});
