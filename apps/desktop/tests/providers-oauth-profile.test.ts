import { describe, expect, it, vi } from "vitest";
import {
  createHermesOAuthPtyKillDeferral,
  findHermesOAuthUrl,
  subscribeAndAttachHermesOAuthPty,
} from "../src/renderer/features/settings/HermesOAuthPtyDialog";
import {
  createChatGptOAuthProfile,
  createHermesOAuthProfile,
  HERMES_OAUTH_PROFILE_PRESETS,
} from "../src/renderer/features/settings/ProvidersTab";

describe("ChatGPT OAuth Profile entry", () => {
  it("creates the fixed Hermes ChatGPT subscription metadata without an API key reference", () => {
    const profile = createChatGptOAuthProfile("chatgpt-oauth");
    expect(profile).toMatchObject({
      id: "chatgpt-oauth",
      kind: "openai",
      model: "gpt-5.4",
      hermes: {
        providerSlug: "openai-codex",
        authMode: "oauth",
        apiMode: "codex_responses",
        executionBackend: "local",
      },
    });
    expect(profile).not.toHaveProperty("credentialRef");
  });

  it("creates legal isolated profiles for every supported OAuth provider without token fields", () => {
    expect(HERMES_OAUTH_PROFILE_PRESETS.map((preset) => preset.id)).toEqual([
      "chatgpt",
      "nous",
      "copilot",
    ]);

    const expected = {
      chatgpt: ["openai-codex", "codex_responses", "gpt-5.4"],
      nous: ["nous", "chat_completions", "anthropic/claude-fable-5"],
      copilot: ["copilot", "codex_responses", "gpt-5.4"],
    } as const;
    for (const preset of HERMES_OAUTH_PROFILE_PRESETS) {
      const profile = createHermesOAuthProfile(preset.id, `${preset.id}-oauth`);
      expect([profile.hermes.providerSlug, profile.hermes.apiMode, profile.model]).toEqual(
        expected[preset.id],
      );
      expect(profile.hermes.authMode).toBe("oauth");
      expect(profile.hermes.executionBackend).toBe("local");
      expect(profile).not.toHaveProperty("credentialRef");
      expect(JSON.stringify(profile)).not.toContain("token");
    }
  });

  it("fails closed for unsupported OAuth preset ids", () => {
    expect(() => createHermesOAuthProfile("anthropic" as never, "bad-profile")).toThrowError(
      "Unsupported Hermes OAuth provider",
    );
  });

  it("locks first-version OAuth Profiles to models matching their fixed transports", () => {
    expect(() =>
      createHermesOAuthProfile("copilot", "copilot-oauth", "claude-sonnet-4"),
    ).toThrowError("Hermes OAuth model is fixed for this release");
    expect(() => createHermesOAuthProfile("chatgpt", "chatgpt-oauth", "gpt 5")).toThrowError(
      "Hermes OAuth model is fixed for this release",
    );
    expect(() => createHermesOAuthProfile("nous", "nous-oauth", "bad\nmodel")).toThrowError(
      "Hermes OAuth model is fixed for this release",
    );
    expect(createHermesOAuthProfile("copilot", "copilot-oauth", "gpt-5.4").hermes.apiMode).toBe(
      "codex_responses",
    );
  });

  it("detects an HTTPS login URL across streamed PTY chunks with a bounded transient tail", () => {
    const first = findHermesOAuthUrl("", "Open https://auth.open");
    const second = findHermesOAuthUrl(first.tail, "ai.com/authorize?state=abc\r\n");
    expect(second.url).toBe("https://auth.openai.com/authorize?state=abc");
    expect(second.tail.length).toBeLessThanOrEqual(8_192);

    const ansi = findHermesOAuthUrl(
      "",
      `Open https://auth.openai.com/authorize?state=abc${String.fromCharCode(27)}[0m`,
    );
    expect(ansi.url).toBe("https://auth.openai.com/authorize?state=abc");
  });

  it("subscribes to data and exit before telling main that the OAuth renderer is ready", async () => {
    const order: string[] = [];
    let onData: ((event: { ptyId: string; data: string }) => void) | undefined;
    let onExit: ((event: { ptyId: string; exitCode: number; signal?: number }) => void) | undefined;
    const received: string[] = [];
    const subscription = subscribeAndAttachHermesOAuthPty(
      {
        onData(handler) {
          order.push("data-listener");
          onData = handler;
          return () => order.push("data-off");
        },
        onExit(handler) {
          order.push("exit-listener");
          onExit = handler;
          return () => order.push("exit-off");
        },
        attach: async ({ ptyId }) => {
          order.push(`attach:${ptyId}`);
        },
      },
      "pty-oauth",
      {
        onData: (event) => received.push(event.data),
        onExit: (event) => received.push(`exit:${event.exitCode}`),
      },
    );

    expect(order).toEqual(["data-listener", "exit-listener", "attach:pty-oauth"]);
    onData?.({ ptyId: "other", data: "not ours" });
    onData?.({ ptyId: "pty-oauth", data: "first" });
    onExit?.({ ptyId: "pty-oauth", exitCode: 0 });
    await subscription.ready;
    expect(received).toEqual(["first", "exit:0"]);

    subscription.detach();
    expect(order.slice(-2)).toEqual(["data-off", "exit-off"]);
  });

  it("does not kill the OAuth PTY during React StrictMode's cleanup and immediate setup", async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn(async () => undefined);
      const deferral = createHermesOAuthPtyKillDeferral(kill);

      deferral.schedule();
      deferral.cancel();
      await vi.runAllTimersAsync();
      expect(kill).not.toHaveBeenCalled();

      deferral.schedule();
      await vi.runAllTimersAsync();
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
