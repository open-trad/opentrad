import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HermesInteractionPrompter,
  type HermesInteractionPromptInput,
} from "../src/main/services/hermes-interaction-prompter";

class FakeWindow extends EventEmitter {
  readonly sent: unknown[] = [];
  destroyed = false;
  readonly webContents = {
    id: 41,
    isDestroyed: (): boolean => this.destroyed,
    send: (_channel: string, payload: unknown): void => {
      this.sent.push(payload);
    },
  };

  isDestroyed(): boolean {
    return this.destroyed;
  }

  closeRenderer(): void {
    this.destroyed = true;
    this.emit("closed");
  }

  asBrowserWindow(): BrowserWindow {
    return this as unknown as BrowserWindow;
  }
}

const APPROVAL: HermesInteractionPromptInput<"approval"> = {
  kind: "approval",
  sessionId: "session-1",
  toolName: "terminal",
  pluginName: "trusted-plugin",
  command: "git status",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("HermesInteractionPrompter", () => {
  it("binds a one-shot approval response to its random request ID and renderer sender", async () => {
    const win = new FakeWindow();
    const prompter = new HermesInteractionPrompter(() => win.asBrowserWindow(), 300_000);

    const pending = prompter.requestApproval(APPROVAL);
    const request = win.sent[0] as { requestId: string; kind: string };
    expect(request).toMatchObject({ kind: "approval", sessionId: "session-1" });
    expect(request.requestId).toMatch(/^[0-9a-f-]{36}$/u);

    expect(
      prompter.handleResponse(
        { requestId: request.requestId, kind: "approval", choice: "session" },
        999,
      ),
    ).toBe(false);
    expect(
      prompter.handleResponse(
        { requestId: request.requestId, kind: "approval", choice: "session" },
        41,
      ),
    ).toBe(true);
    await expect(pending).resolves.toBe("session");
    expect(
      prompter.handleResponse(
        { requestId: request.requestId, kind: "approval", choice: "always" },
        41,
      ),
    ).toBe(false);
  });

  it("defaults malformed same-renderer responses to deny or an empty cancellation", async () => {
    const win = new FakeWindow();
    const prompter = new HermesInteractionPrompter(() => win.asBrowserWindow(), 300_000);
    const approval = prompter.requestApproval(APPROVAL);
    const approvalId = (win.sent.at(-1) as { requestId: string }).requestId;

    expect(
      prompter.handleResponse(
        { requestId: approvalId, kind: "approval", choice: "allow_session" },
        41,
      ),
    ).toBe(false);
    await expect(approval).resolves.toBe("deny");

    const secret = prompter.requestSecret({
      kind: "secret",
      sessionId: "session-1",
      prompt: "Enter secret",
      secretName: "SERVICE_TOKEN",
    });
    const secretId = (win.sent.at(-1) as { requestId: string }).requestId;
    expect(
      prompter.handleResponse({ requestId: secretId, kind: "secret", value: "bad\0secret" }, 41),
    ).toBe(false);
    await expect(secret).resolves.toBe("");
  });

  it("denies or cancels on timeout, renderer close, missing renderer, and cleanup", async () => {
    vi.useFakeTimers();
    const win = new FakeWindow();
    const prompter = new HermesInteractionPrompter(() => win.asBrowserWindow(), 300_000);
    const timed = prompter.requestApproval(APPROVAL);
    await vi.advanceTimersByTimeAsync(300_000);
    await expect(timed).resolves.toBe("deny");

    const sudo = prompter.requestSudo({
      kind: "sudo",
      sessionId: "session-1",
      prompt: "Administrator password",
    });
    win.closeRenderer();
    await expect(sudo).resolves.toBe("");

    const missing = new HermesInteractionPrompter(() => null, 300_000);
    await expect(missing.requestApproval(APPROVAL)).resolves.toBe("deny");

    const fresh = new FakeWindow();
    const cleaning = new HermesInteractionPrompter(() => fresh.asBrowserWindow(), 300_000);
    const secret = cleaning.requestSecret({
      kind: "secret",
      sessionId: "session-1",
      prompt: "Tool secret",
    });
    cleaning.cleanupAll();
    await expect(secret).resolves.toBe("");
  });

  it("cancels when sending the request throws", async () => {
    const win = new FakeWindow();
    win.webContents.send = (): never => {
      throw new Error("IPC transport failed");
    };
    const prompter = new HermesInteractionPrompter(() => win.asBrowserWindow(), 300_000);

    await expect(
      prompter.requestSudo({ kind: "sudo", sessionId: "session-1", prompt: "Password" }),
    ).resolves.toBe("");
  });

  it("fails closed when resolving the renderer target throws", async () => {
    const prompter = new HermesInteractionPrompter(() => {
      throw new Error("window lookup failed");
    }, 300_000);

    await expect(prompter.requestApproval(APPROVAL)).resolves.toBe("deny");
  });
});
