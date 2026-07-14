import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbServices, type DbServices } from "../../src/main/services/db";

describe("AgentRuntimeBindingService", () => {
  let services: DbServices;

  beforeEach(() => {
    services = createDbServices({ dbPath: ":memory:" });
  });

  afterEach(() => {
    services.close();
  });

  function createSession(sessionId: string, createdAt = 100): void {
    services.agentSessions.create(sessionId, "deepseek-chat", createdAt);
  }

  it("creates and reads an OpenTrad-to-Hermes binding without a durable id", () => {
    createSession("open-1");

    services.agentRuntimeBindings.create({
      sessionId: "open-1",
      profileId: "profile-deepseek",
      workspaceRoot: "/Users/example/project",
      status: "creating",
      createdAt: 100,
    });

    expect(services.agentRuntimeBindings.get("open-1")).toEqual({
      sessionId: "open-1",
      durableSessionId: null,
      profileId: "profile-deepseek",
      workspaceRoot: "/Users/example/project",
      status: "creating",
      resumable: false,
      generation: 0,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(services.agentSessions.get("open-1")).toMatchObject({
      profileId: "profile-deepseek",
      workspaceRoot: "/Users/example/project",
      status: "creating",
      resumable: false,
    });
  });

  it("attaches the durable Hermes identity and updates recovery status atomically", () => {
    createSession("open-1");
    services.agentRuntimeBindings.create({
      sessionId: "open-1",
      profileId: "profile-deepseek",
      workspaceRoot: "/Users/example/project",
      status: "creating",
      createdAt: 100,
    });

    expect(
      services.agentRuntimeBindings.attachDurableSession({
        sessionId: "open-1",
        durableSessionId: "20260713_010203_abcdef",
        status: "active",
        resumable: true,
        updatedAt: 110,
      }),
    ).toBe(true);
    expect(
      services.agentRuntimeBindings.updateStatus({
        sessionId: "open-1",
        status: "idle",
        resumable: true,
        expectedGeneration: 1,
        updatedAt: 120,
      }),
    ).toBe(true);

    expect(services.agentRuntimeBindings.get("open-1")).toMatchObject({
      durableSessionId: "20260713_010203_abcdef",
      status: "idle",
      resumable: true,
      generation: 2,
      updatedAt: 120,
    });
  });

  it("attaches a durable identity once and treats the same identity as idempotent", () => {
    createSession("open-1");
    services.agentRuntimeBindings.create({
      sessionId: "open-1",
      profileId: "profile-deepseek",
      workspaceRoot: "/workspace/one",
      status: "creating",
      createdAt: 10,
    });

    expect(
      services.agentRuntimeBindings.attachDurableSession({
        sessionId: "open-1",
        durableSessionId: "durable-first",
        status: "active",
        resumable: true,
        updatedAt: 20,
      }),
    ).toBe(true);
    expect(
      services.agentRuntimeBindings.attachDurableSession({
        sessionId: "open-1",
        durableSessionId: "durable-first",
        status: "error",
        resumable: false,
        updatedAt: 30,
      }),
    ).toBe(true);
    expect(
      services.agentRuntimeBindings.attachDurableSession({
        sessionId: "open-1",
        durableSessionId: "durable-replacement",
        status: "active",
        resumable: true,
        updatedAt: 40,
      }),
    ).toBe(false);

    expect(services.agentRuntimeBindings.get("open-1")).toMatchObject({
      durableSessionId: "durable-first",
      status: "active",
      resumable: true,
      generation: 1,
      updatedAt: 20,
    });
  });

  it("rejects out-of-order status transitions with generation compare-and-swap", () => {
    createSession("open-1");
    services.agentRuntimeBindings.create({
      sessionId: "open-1",
      profileId: "profile-deepseek",
      workspaceRoot: "/workspace/one",
      status: "creating",
      createdAt: 10,
    });
    services.agentRuntimeBindings.attachDurableSession({
      sessionId: "open-1",
      durableSessionId: "durable-first",
      status: "active",
      resumable: true,
      updatedAt: 20,
    });

    expect(
      services.agentRuntimeBindings.updateStatus({
        sessionId: "open-1",
        status: "idle",
        resumable: true,
        expectedGeneration: 1,
        updatedAt: 30,
      }),
    ).toBe(true);
    expect(
      services.agentRuntimeBindings.updateStatus({
        sessionId: "open-1",
        status: "error",
        resumable: false,
        expectedGeneration: 1,
        updatedAt: 40,
      }),
    ).toBe(false);

    expect(services.agentRuntimeBindings.get("open-1")).toMatchObject({
      status: "idle",
      resumable: true,
      generation: 2,
      updatedAt: 30,
    });
  });

  it("cannot mark a binding resumable before a durable identity exists", () => {
    createSession("open-1");
    services.agentRuntimeBindings.create({
      sessionId: "open-1",
      profileId: "profile-deepseek",
      workspaceRoot: "/workspace/one",
      status: "creating",
      createdAt: 10,
    });

    expect(
      services.agentRuntimeBindings.updateStatus({
        sessionId: "open-1",
        status: "idle",
        resumable: true,
        expectedGeneration: 0,
        updatedAt: 20,
      }),
    ).toBe(false);
    expect(() =>
      services.db
        .prepare("UPDATE agent_runtime_bindings SET resumable = 1 WHERE session_id = 'open-1'")
        .run(),
    ).toThrow();
    expect(services.agentRuntimeBindings.get("open-1")).toMatchObject({
      durableSessionId: null,
      resumable: false,
      generation: 0,
    });
    expect(services.agentRuntimeBindings.listResumable()).toEqual([]);
  });

  it("lists only resumable rows with durable Hermes identities", () => {
    for (const [sessionId, createdAt] of [
      ["resumable", 100],
      ["not-ready", 200],
      ["closed", 300],
    ] as const) {
      createSession(sessionId, createdAt);
      services.agentRuntimeBindings.create({
        sessionId,
        profileId: "profile-deepseek",
        workspaceRoot: `/workspace/${sessionId}`,
        status: "creating",
        createdAt,
      });
    }
    services.agentRuntimeBindings.attachDurableSession({
      sessionId: "resumable",
      durableSessionId: "20260713_010203_aaaaaa",
      status: "idle",
      resumable: true,
      updatedAt: 400,
    });
    services.agentRuntimeBindings.attachDurableSession({
      sessionId: "closed",
      durableSessionId: "20260713_010203_bbbbbb",
      status: "closed",
      resumable: false,
      updatedAt: 410,
    });

    expect(services.agentRuntimeBindings.listResumable().map((row) => row.sessionId)).toEqual([
      "resumable",
    ]);
  });

  it("makes every binding read-only before its Provider Profile is deleted", () => {
    for (const [sessionId, profileId] of [
      ["profile-a-1", "profile-a"],
      ["profile-a-2", "profile-a"],
      ["profile-b-1", "profile-b"],
    ] as const) {
      createSession(sessionId);
      services.agentRuntimeBindings.create({
        sessionId,
        profileId,
        workspaceRoot: `/workspace/${sessionId}`,
        status: "creating",
        createdAt: 1,
      });
      services.agentRuntimeBindings.attachDurableSession({
        sessionId,
        durableSessionId: `durable-${sessionId}`,
        status: "idle",
        resumable: true,
        updatedAt: 2,
      });
    }

    expect(services.agentRuntimeBindings.invalidateProfile("profile-a", 10)).toBe(2);
    expect(services.agentRuntimeBindings.invalidateProfile("profile-a", 11)).toBe(0);
    expect(services.agentRuntimeBindings.get("profile-a-1")).toMatchObject({
      status: "read_only",
      resumable: false,
      generation: 2,
      updatedAt: 10,
    });
    expect(services.agentRuntimeBindings.get("profile-a-2")).toMatchObject({
      status: "read_only",
      resumable: false,
    });
    expect(services.agentRuntimeBindings.get("profile-b-1")).toMatchObject({
      status: "idle",
      resumable: true,
    });
  });

  it("enforces one binding per OpenTrad session and one durable id per profile", () => {
    createSession("open-1");
    createSession("open-2");
    createSession("open-3");
    services.agentRuntimeBindings.create({
      sessionId: "open-1",
      profileId: "profile-a",
      workspaceRoot: "/workspace/one",
      status: "creating",
      createdAt: 1,
    });
    expect(() =>
      services.agentRuntimeBindings.create({
        sessionId: "open-1",
        profileId: "profile-a",
        workspaceRoot: "/workspace/duplicate",
        status: "creating",
        createdAt: 2,
      }),
    ).toThrow();

    services.agentRuntimeBindings.attachDurableSession({
      sessionId: "open-1",
      durableSessionId: "20260713_010203_aaaaaa",
      status: "idle",
      resumable: true,
      updatedAt: 3,
    });
    services.agentRuntimeBindings.create({
      sessionId: "open-2",
      profileId: "profile-a",
      workspaceRoot: "/workspace/two",
      status: "creating",
      createdAt: 4,
    });
    expect(() =>
      services.agentRuntimeBindings.attachDurableSession({
        sessionId: "open-2",
        durableSessionId: "20260713_010203_aaaaaa",
        status: "idle",
        resumable: true,
        updatedAt: 5,
      }),
    ).toThrow();

    services.agentRuntimeBindings.create({
      sessionId: "open-3",
      profileId: "profile-b",
      workspaceRoot: "/workspace/three",
      status: "creating",
      createdAt: 6,
    });
    expect(
      services.agentRuntimeBindings.attachDurableSession({
        sessionId: "open-3",
        durableSessionId: "20260713_010203_aaaaaa",
        status: "idle",
        resumable: true,
        updatedAt: 7,
      }),
    ).toBe(true);
    // Durable ids live inside a profile-specific HERMES_HOME namespace. The same
    // upstream id is therefore valid for a different profile, but not the same one.
  });

  it("cascades binding deletion with the OpenTrad session and reports missing updates", () => {
    createSession("open-1");
    services.agentRuntimeBindings.create({
      sessionId: "open-1",
      profileId: "profile-a",
      workspaceRoot: "/workspace/one",
      status: "creating",
      createdAt: 1,
    });

    expect(
      services.agentRuntimeBindings.updateStatus({
        sessionId: "missing",
        status: "error",
        resumable: false,
        expectedGeneration: 0,
        updatedAt: 2,
      }),
    ).toBe(false);
    services.agentSessions.delete("open-1");
    expect(services.agentRuntimeBindings.get("open-1")).toBeUndefined();
  });
});
