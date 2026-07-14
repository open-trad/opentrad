import type { HermesInteractionRequest } from "@opentrad/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HermesInteractionDialog } from "../src/renderer/features/agent/HermesInteractionOverlay";

const requestId = "123e4567-e89b-42d3-a456-426614174000";

function render(request: HermesInteractionRequest): string {
  return renderToStaticMarkup(
    createElement(HermesInteractionDialog, { request, onRespond: () => {} }),
  );
}

describe("HermesInteractionDialog", () => {
  it("shows all approval scopes and the trusted-code warning", () => {
    const html = render({
      requestId,
      kind: "approval",
      sessionId: "session-1",
      pluginName: "filesystem-plugin",
      command: "rm example.txt",
    });

    expect(html).toContain("仅本次");
    expect(html).toContain("本会话");
    expect(html).toContain("始终允许");
    expect(html).toContain("拒绝");
    expect(html).toContain("受信代码");
    expect(html).toContain("filesystem-plugin");
    expect(html).toContain("rm example.txt");
  });

  it("uses a password input for sudo and never displays a stored value", () => {
    const html = render({
      requestId,
      kind: "sudo",
      sessionId: "session-1",
      prompt: "Administrator password",
    });

    expect(html).toContain('type="password"');
    expect(html).toContain("不会保存");
  });

  it("uses a password input and explains the private 0600 profile .env for secrets", () => {
    const html = render({
      requestId,
      kind: "secret",
      sessionId: "session-1",
      prompt: "Service token",
      secretName: "SERVICE_TOKEN",
    });

    expect(html).toContain('type="password"');
    expect(html).toContain("Profile Home");
    expect(html).toContain("0600");
    expect(html).toContain(".env");
    expect(html).toContain("SERVICE_TOKEN");
  });
});
