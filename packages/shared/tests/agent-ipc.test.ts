import { describe, expect, it } from "vitest";
import { IpcChannels } from "../src/channels";
import {
  AgentProfileSaveRequestSchema,
  AgentSessionMetaSchema,
  AgentSessionOpenResponseSchema,
  AgentStartSessionRequestSchema,
  AgentStartSessionResponseSchema,
  AgentWorkspaceSelectResponseSchema,
  HermesInteractionRequestSchema,
  HermesInteractionResponseSchema,
} from "../src/types/agent-ipc";

describe("agent Profile mutation IPC contracts", () => {
  it("carries an optional write-only credential in the same save request", () => {
    expect(
      AgentProfileSaveRequestSchema.parse({
        profile: { id: "profile-1" },
        credential: { ref: "apikey:profile-1", secret: "test-only-secret" },
      }),
    ).toEqual({
      profile: { id: "profile-1" },
      credential: { ref: "apikey:profile-1", secret: "test-only-secret" },
    });
    expect(
      AgentProfileSaveRequestSchema.safeParse({
        profile: { id: "profile-1" },
        credential: { ref: "apikey:profile-1", secret: "" },
      }).success,
    ).toBe(false);
    expect(
      AgentProfileSaveRequestSchema.safeParse({
        profile: { id: "profile-1" },
        credential: { ref: "apikey:profile-1", secret: "bad\0secret" },
      }).success,
    ).toBe(false);
    expect(
      AgentProfileSaveRequestSchema.safeParse({
        profile: { id: "profile-1" },
        credential: { ref: "apikey:profile-1", secret: "界".repeat(65_537) },
      }).success,
    ).toBe(false);
    expect(
      AgentProfileSaveRequestSchema.safeParse({
        profile: { id: "profile-1" },
        credential: { ref: "apikey:profile-1", secret: "test-only-secret", extra: true },
      }).success,
    ).toBe(false);
  });

  it("does not expose independent credential mutation channels to renderer", () => {
    expect("AgentCredentialsSet" in IpcChannels).toBe(false);
    expect("AgentCredentialsDelete" in IpcChannels).toBe(false);
  });
});

describe("agent session creation IPC contracts", () => {
  it("tells renderer whether the newly created runtime session is resumable", () => {
    expect(
      AgentStartSessionResponseSchema.parse({ sessionId: "session-1", resumable: true }),
    ).toEqual({ sessionId: "session-1", resumable: true });
    expect(AgentStartSessionResponseSchema.safeParse({ sessionId: "session-1" }).success).toBe(
      false,
    );
  });
});

describe("Hermes interaction IPC contracts", () => {
  it("accepts the three non-sensitive prompt shapes", () => {
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    expect(
      HermesInteractionRequestSchema.parse({
        requestId,
        kind: "approval",
        sessionId: "session-1",
        toolName: "terminal",
        pluginName: "trusted-plugin",
        command: "git status",
      }),
    ).toMatchObject({ kind: "approval", command: "git status" });
    expect(
      HermesInteractionRequestSchema.parse({
        requestId,
        kind: "sudo",
        sessionId: "session-1",
        prompt: "Hermes needs administrator access",
      }),
    ).toMatchObject({ kind: "sudo" });
    expect(
      HermesInteractionRequestSchema.parse({
        requestId,
        kind: "secret",
        sessionId: "session-1",
        prompt: "Enter the tool secret",
        secretName: "SERVICE_TOKEN",
      }),
    ).toMatchObject({ kind: "secret", secretName: "SERVICE_TOKEN" });
  });

  it("accepts approval once/session/always/deny choices", () => {
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    for (const choice of ["once", "session", "always", "deny"] as const) {
      expect(
        HermesInteractionResponseSchema.parse({
          requestId,
          kind: "approval",
          choice,
        }),
      ).toEqual({ requestId, kind: "approval", choice });
    }
  });

  it("allows empty sudo/secret values only as explicit cancellation", () => {
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    expect(HermesInteractionResponseSchema.parse({ requestId, kind: "sudo", value: "" })).toEqual({
      requestId,
      kind: "sudo",
      value: "",
    });
    expect(HermesInteractionResponseSchema.parse({ requestId, kind: "secret", value: "" })).toEqual(
      { requestId, kind: "secret", value: "" },
    );
    expect(
      HermesInteractionResponseSchema.safeParse({
        requestId,
        kind: "sudo",
        value: "bad\0password",
      }).success,
    ).toBe(false);
    expect(
      HermesInteractionResponseSchema.safeParse({
        requestId,
        kind: "secret",
        value: "x".repeat(65_537),
      }).success,
    ).toBe(false);
  });

  it("rejects extra fields so renderer cannot choose an upstream request identity", () => {
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    expect(
      HermesInteractionResponseSchema.safeParse({
        requestId,
        kind: "secret",
        value: "private",
        upstreamRequestId: "forged",
      }).success,
    ).toBe(false);
  });
});

describe("agent IPC Hermes session contracts", () => {
  it("accepts a workspace root on new session requests", () => {
    expect(
      AgentStartSessionRequestSchema.parse({
        profileId: "profile-1",
        workspaceRoot: "/Users/example/workspace",
      }),
    ).toMatchObject({
      profileId: "profile-1",
      workspaceRoot: "/Users/example/workspace",
    });
  });

  it("requires an explicit non-empty workspace selection", () => {
    expect(AgentStartSessionRequestSchema.safeParse({ profileId: "profile-1" }).success).toBe(
      false,
    );
    expect(
      AgentStartSessionRequestSchema.safeParse({ profileId: "profile-1", workspaceRoot: "" })
        .success,
    ).toBe(false);
  });

  it("accepts Hermes binding metadata and keeps old history rows readable", () => {
    expect(
      AgentSessionMetaSchema.parse({
        sessionId: "session-1",
        title: null,
        model: "deepseek-chat",
        createdAt: 1,
        profileId: "profile-1",
        workspaceRoot: "/Users/example/workspace",
        status: "active",
        resumable: true,
      }),
    ).toMatchObject({
      profileId: "profile-1",
      workspaceRoot: "/Users/example/workspace",
      status: "active",
      resumable: true,
    });

    expect(
      AgentSessionMetaSchema.parse({
        sessionId: "legacy-session",
        title: "Legacy",
        model: null,
        createdAt: 1,
      }),
    ).toMatchObject({ sessionId: "legacy-session" });
  });

  it("rejects invalid session runtime metadata", () => {
    const base = {
      sessionId: "session-1",
      title: null,
      model: null,
      createdAt: 1,
    };
    expect(AgentSessionMetaSchema.safeParse({ ...base, profileId: "" }).success).toBe(false);
    expect(AgentSessionMetaSchema.safeParse({ ...base, workspaceRoot: "" }).success).toBe(false);
    expect(AgentSessionMetaSchema.safeParse({ ...base, status: "unknown" }).success).toBe(false);
  });

  it.each([
    { profileId: "profile-1" },
    { workspaceRoot: "/Users/example/workspace" },
    { status: "active" },
    { resumable: true },
    {
      profileId: "profile-1",
      workspaceRoot: "/Users/example/workspace",
      status: "active",
    },
  ])("rejects partial runtime binding metadata: %j", (partial) => {
    expect(
      AgentSessionMetaSchema.safeParse({
        sessionId: "session-1",
        title: null,
        model: null,
        createdAt: 1,
        ...partial,
      }).success,
    ).toBe(false);
  });

  it("validates immediate replay plus background recovery responses", () => {
    expect(
      AgentSessionOpenResponseSchema.parse({
        session: {
          sessionId: "session-1",
          title: null,
          model: "deepseek-chat",
          createdAt: 1,
          profileId: "profile-1",
          workspaceRoot: "/Users/example/workspace",
          status: "resuming",
          resumable: true,
        },
        events: [{ type: "agent_user", text: "hello" }],
        recovery: "resuming",
      }).recovery,
    ).toBe("resuming");
    expect(AgentWorkspaceSelectResponseSchema.parse(null)).toBeNull();
    expect(
      AgentWorkspaceSelectResponseSchema.parse({ workspaceRoot: "/Users/example/workspace" }),
    ).toEqual({ workspaceRoot: "/Users/example/workspace" });
  });
});
