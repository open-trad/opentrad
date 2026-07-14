import { EventEmitter } from "node:events";
import type { ProviderProfile } from "@opentrad/model-providers";
import { describe, expect, it, vi } from "vitest";
import { createHermesOAuthPtyCoordinator } from "../src/main/services/hermes/oauth-login";

describe("Hermes OAuth PTY coordinator", () => {
  it("installs first, prepares the isolated Profile Home, and spawns only the official command", async () => {
    const order: string[] = [];
    const owner = { id: 41 };
    const ready = vi.fn(async () => {
      order.push("ready");
      return { kind: "hermes", version: "0.18.2" };
    });
    const ensureStateDirs = vi.fn(async () => {
      order.push("dirs");
    });
    const spawn = vi.fn(() => {
      order.push("spawn");
      return "pty-hermes-oauth";
    });
    const bind = vi.fn(() => {
      order.push("bind");
    });
    const kill = vi.fn();
    const ptyEvents = new EventEmitter();
    const coordinator = createHermesOAuthPtyCoordinator({
      dataRoot: "/Users/me/.opentrad",
      platform: "darwin",
      runtime: { ready },
      listProfiles: () => [oauthProfile()],
      pty: { spawn, kill, on: ptyEvents.on.bind(ptyEvents) },
      ptyRouter: { bind },
      ensureStateDirs,
      hostEnv: {
        HOME: "/Users/me",
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "must-not-leak",
      },
    });

    await expect(coordinator.start("chatgpt", owner as never)).resolves.toEqual({
      ptyId: "pty-hermes-oauth",
    });
    expect(order).toEqual(["ready", "dirs", "spawn", "bind"]);
    expect(ensureStateDirs).toHaveBeenCalledWith(
      expect.objectContaining({
        hermesHome: "/Users/me/.opentrad/hermes/profile-homes/chatgpt",
        gatewayCwd: "/Users/me/.opentrad/hermes/profile-homes/chatgpt/gateway-cwd",
      }),
      { dataRoot: "/Users/me/.opentrad" },
    );
    expect(spawn).toHaveBeenCalledWith({
      command: "/Users/me/.opentrad/runtimes/hermes/0.18.2/venv/bin/python3",
      args: [
        "-I",
        "-B",
        "-u",
        "-X",
        "utf8",
        "-c",
        expect.stringContaining(
          'sys.argv = ["hermes","auth","add","openai-codex","--type","oauth"]',
        ),
      ],
      cwd: "/Users/me/.opentrad/hermes/profile-homes/chatgpt/gateway-cwd",
      env: {
        HOME: "/Users/me",
        PATH: "/usr/bin:/bin",
        LANG: "en_US.UTF-8",
        HERMES_HOME: "/Users/me/.opentrad/hermes/profile-homes/chatgpt",
        GH_CONFIG_DIR: "/Users/me/.opentrad/hermes/profile-homes/chatgpt/gh-config",
        XDG_CONFIG_HOME: "/Users/me/.opentrad/hermes/profile-homes/chatgpt/xdg-config",
        COPILOT_GH_HOST: expect.stringMatching(/^[a-f0-9]{24}\.opentrad\.invalid$/),
        CODEX_HOME: "/Users/me/.opentrad/hermes/profile-homes/chatgpt/codex-home",
      },
      inheritEnv: false,
    });
    expect(bind).toHaveBeenCalledWith("pty-hermes-oauth", owner, { deferUntilAttach: true });
    expect(JSON.stringify(spawn.mock.calls)).not.toContain("must-not-leak");
  });

  it("kills the managed login PTY when private renderer binding fails", async () => {
    const spawn = vi.fn(() => "pty-unbound");
    const kill = vi.fn();
    const ptyEvents = new EventEmitter();
    const coordinator = createHermesOAuthPtyCoordinator({
      dataRoot: "/Users/me/.opentrad",
      platform: "darwin",
      runtime: { ready: vi.fn(async () => ({ kind: "hermes", version: "0.18.2" })) },
      listProfiles: () => [oauthProfile()],
      pty: { spawn, kill, on: ptyEvents.on.bind(ptyEvents) },
      ptyRouter: {
        bind: vi.fn(() => {
          throw new Error("renderer disappeared");
        }),
      },
      ensureStateDirs: vi.fn(async () => undefined),
    });

    await expect(coordinator.start("chatgpt", {} as never)).rejects.toThrow("renderer disappeared");
    expect(kill).toHaveBeenCalledWith("pty-unbound");
  });

  it("fails closed for legacy mode, missing profiles, and API-key profiles", async () => {
    const ptyEvents = new EventEmitter();
    const base = {
      dataRoot: "/Users/me/.opentrad",
      platform: "darwin",
      listProfiles: () => [oauthProfile()],
      pty: {
        spawn: vi.fn(),
        kill: vi.fn(),
        on: ptyEvents.on.bind(ptyEvents),
      },
      ptyRouter: { bind: vi.fn() },
    };

    await expect(
      createHermesOAuthPtyCoordinator(base).start("chatgpt", {} as never),
    ).rejects.toMatchObject({
      code: "HERMES_OAUTH_LEGACY_RUNTIME",
      message: "Hermes OAuth is unavailable while OPENTRAD_RUNTIME=legacy",
    });
    await expect(
      createHermesOAuthPtyCoordinator({
        ...base,
        runtime: { ready: vi.fn() },
        listProfiles: () => [],
      }).start("missing", {} as never),
    ).rejects.toMatchObject({ code: "HERMES_OAUTH_PROFILE_INVALID" });
    await expect(
      createHermesOAuthPtyCoordinator({
        ...base,
        runtime: { ready: vi.fn() },
        listProfiles: () => [
          {
            ...oauthProfile(),
            hermes: { ...oauthProfile().hermes, authMode: "api_key" },
          },
        ],
      }).start("chatgpt", {} as never),
    ).rejects.toMatchObject({ code: "HERMES_OAUTH_PROFILE_INVALID" });

    const spawn = vi.fn();
    const ready = vi.fn();
    await expect(
      createHermesOAuthPtyCoordinator({
        ...base,
        runtime: { ready },
        pty: { spawn, kill: vi.fn(), on: ptyEvents.on.bind(ptyEvents) },
        listProfiles: () => [
          {
            ...oauthProfile(),
            hermes: { ...oauthProfile().hermes, providerSlug: "unsupported-oauth" },
          },
        ],
      }).start("chatgpt", {} as never),
    ).rejects.toMatchObject({ code: "HERMES_OAUTH_LOGIN_INVALID" });
    expect(ready).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("kills every active login for one Profile and waits for all PTYs to exit", async () => {
    const harness = createPtyHarness(["pty-chatgpt-1", "pty-chatgpt-2", "pty-nous"]);
    const coordinator = createHermesOAuthPtyCoordinator({
      dataRoot: "/Users/me/.opentrad",
      platform: "darwin",
      runtime: { ready: vi.fn(async () => ({ kind: "hermes", version: "0.18.2" })) },
      listProfiles: () => [oauthProfile(), oauthProfile("nous")],
      pty: harness.pty,
      ptyRouter: { bind: vi.fn() },
      ensureStateDirs: vi.fn(async () => undefined),
    });

    await coordinator.start("chatgpt", {} as never);
    await coordinator.start("chatgpt", {} as never);
    await coordinator.start("nous", {} as never);

    const invalidating = coordinator.invalidateProfile("chatgpt");
    let settled = false;
    void invalidating.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    expect(harness.kill).toHaveBeenCalledTimes(2);
    expect(harness.kill).toHaveBeenNthCalledWith(1, "pty-chatgpt-1");
    expect(harness.kill).toHaveBeenNthCalledWith(2, "pty-chatgpt-2");

    harness.exit("pty-chatgpt-1");
    await Promise.resolve();
    expect(settled).toBe(false);
    harness.exit("pty-chatgpt-2");

    await expect(invalidating).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(harness.kill).not.toHaveBeenCalledWith("pty-nous");
  });

  it("removes a normally exited login from Profile invalidation tracking", async () => {
    const harness = createPtyHarness(["pty-finished"]);
    const coordinator = createHermesOAuthPtyCoordinator({
      dataRoot: "/Users/me/.opentrad",
      platform: "darwin",
      runtime: { ready: vi.fn(async () => ({ kind: "hermes", version: "0.18.2" })) },
      listProfiles: () => [oauthProfile()],
      pty: harness.pty,
      ptyRouter: { bind: vi.fn() },
      ensureStateDirs: vi.fn(async () => undefined),
    });

    await coordinator.start("chatgpt", {} as never);
    harness.exit("pty-finished");

    await expect(coordinator.invalidateProfile("chatgpt")).resolves.toBeUndefined();
    expect(harness.kill).not.toHaveBeenCalled();
  });

  it("fails closed within a bound when a killed login never reports exit", async () => {
    vi.useFakeTimers();
    try {
      const harness = createPtyHarness(["pty-stuck", "pty-after-retry"]);
      const coordinator = createHermesOAuthPtyCoordinator({
        dataRoot: "/Users/me/.opentrad",
        platform: "darwin",
        runtime: { ready: vi.fn(async () => ({ kind: "hermes", version: "0.18.2" })) },
        listProfiles: () => [oauthProfile()],
        pty: harness.pty,
        ptyRouter: { bind: vi.fn() },
        ensureStateDirs: vi.fn(async () => undefined),
        invalidationTimeoutMs: 25,
      });
      await coordinator.start("chatgpt", {} as never);

      const invalidating = coordinator.invalidateProfile("chatgpt");
      const rejection = expect(invalidating).rejects.toMatchObject({
        code: "HERMES_OAUTH_PTY_DRAIN_TIMEOUT",
      });
      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(harness.kill).toHaveBeenCalledWith("pty-stuck");
      await expect(coordinator.start("chatgpt", {} as never)).rejects.toMatchObject({
        code: "HERMES_OAUTH_PROFILE_INVALIDATED",
      });
      expect(harness.spawn).toHaveBeenCalledTimes(1);

      harness.exit("pty-stuck");
      await expect(coordinator.invalidateProfile("chatgpt")).resolves.toBeUndefined();
      await expect(coordinator.start("chatgpt", {} as never)).resolves.toEqual({
        ptyId: "pty-after-retry",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains and rejects a pre-spawn login captured before Profile invalidation", async () => {
    const dirs = deferred<void>();
    const harness = createPtyHarness(["must-not-spawn"]);
    const ensureStateDirs = vi.fn(async () => dirs.promise);
    const coordinator = createHermesOAuthPtyCoordinator({
      dataRoot: "/Users/me/.opentrad",
      platform: "darwin",
      runtime: { ready: vi.fn(async () => ({ kind: "hermes", version: "0.18.2" })) },
      listProfiles: () => [oauthProfile()],
      pty: harness.pty,
      ptyRouter: { bind: vi.fn() },
      ensureStateDirs,
      invalidationTimeoutMs: 100,
    });

    const starting = coordinator.start("chatgpt", {} as never);
    await vi.waitFor(() => expect(ensureStateDirs).toHaveBeenCalledTimes(1));
    const invalidating = coordinator.invalidateProfile("chatgpt");
    dirs.resolve();

    await expect(starting).rejects.toMatchObject({
      code: "HERMES_OAUTH_PROFILE_INVALIDATED",
    });
    await expect(invalidating).resolves.toBeUndefined();
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it("rejects an unavailable Profile before install and rechecks after awaited preparation", async () => {
    let available = false;
    const readyGate = deferred<{ kind: string; version: string }>();
    const ready = vi.fn(async () => readyGate.promise);
    const ensureStateDirs = vi.fn(async () => undefined);
    const harness = createPtyHarness(["must-not-spawn"]);
    const coordinator = createHermesOAuthPtyCoordinator({
      dataRoot: "/Users/me/.opentrad",
      platform: "darwin",
      runtime: { ready },
      listProfiles: () => [oauthProfile()],
      isProfileAvailable: () => available,
      pty: harness.pty,
      ptyRouter: { bind: vi.fn() },
      ensureStateDirs,
    });

    await expect(coordinator.start("chatgpt", {} as never)).rejects.toMatchObject({
      code: "HERMES_OAUTH_PROFILE_INVALIDATED",
    });
    expect(ready).not.toHaveBeenCalled();

    available = true;
    const starting = coordinator.start("chatgpt", {} as never);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
    available = false;
    readyGate.resolve({ kind: "hermes", version: "0.18.2" });

    await expect(starting).rejects.toMatchObject({
      code: "HERMES_OAUTH_PROFILE_INVALIDATED",
    });
    expect(ensureStateDirs).not.toHaveBeenCalled();
    expect(harness.spawn).not.toHaveBeenCalled();
  });
});

function oauthProfile(id = "chatgpt"): ProviderProfile {
  return {
    id,
    displayName: "ChatGPT OAuth",
    kind: "openai",
    model: "gpt-5.4",
    pricing: null,
    hermes: {
      providerSlug: "openai-codex",
      authMode: "oauth",
      apiMode: "codex_responses",
      executionBackend: "local",
    },
  };
}

function createPtyHarness(ptyIds: string[]) {
  const events = new EventEmitter();
  const spawn = vi.fn(() => {
    const ptyId = ptyIds.shift();
    if (!ptyId) throw new Error("no fake PTY id available");
    return ptyId;
  });
  const kill = vi.fn();
  return {
    pty: {
      spawn,
      kill,
      on: events.on.bind(events),
    },
    spawn,
    kill,
    exit(ptyId: string) {
      events.emit("exit", { ptyId, exitCode: 0 });
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
