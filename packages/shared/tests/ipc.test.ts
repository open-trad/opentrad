import { describe, expect, it } from "vitest";
import {
  CCStartTaskRequestSchema,
  CCStatusSchema,
  IpcChannels,
  SessionMetaSchema,
  SettingsSetRequestSchema,
} from "../src";

describe("IpcChannels constants", () => {
  it("matches canonical channel names from 03-architecture.md §3", () => {
    expect(IpcChannels.CCStartTask).toBe("cc:start-task");
    expect(IpcChannels.CCEvent).toBe("cc:event");
    expect(IpcChannels.RiskGateConfirm).toBe("risk-gate:confirm");
    expect(IpcChannels.SettingsSet).toBe("settings:set");
  });
});

describe("CCStartTask schema", () => {
  it("accepts skillId with arbitrary inputs map", () => {
    const raw = {
      skillId: "trade-email-writer",
      inputs: { context: "报价信", tone: "formal" },
    };
    expect(CCStartTaskRequestSchema.safeParse(raw).success).toBe(true);
  });

  it("accepts empty inputs object", () => {
    expect(
      CCStartTaskRequestSchema.safeParse({
        skillId: "x",
        inputs: {},
      }).success,
    ).toBe(true);
  });
});

describe("CCStatus schema", () => {
  it("allows installed=false without other fields", () => {
    expect(CCStatusSchema.safeParse({ installed: false }).success).toBe(true);
  });

  it("accepts fully-populated status", () => {
    expect(
      CCStatusSchema.safeParse({
        installed: true,
        version: "2.1.119",
        loggedIn: true,
        email: "u***@example.com",
        authMethod: "subscription",
      }).success,
    ).toBe(true);
  });

  it("rejects invalid authMethod", () => {
    expect(
      CCStatusSchema.safeParse({
        installed: true,
        authMethod: "oauth",
      }).success,
    ).toBe(false);
  });

  it("accepts error message for CC detection failures", () => {
    expect(
      CCStatusSchema.safeParse({
        installed: false,
        error: "claude binary not found in PATH",
      }).success,
    ).toBe(true);
  });
});

describe("SessionMeta schema", () => {
  it("parses typical completed session", () => {
    const raw = {
      id: "abc",
      title: "报价邮件",
      skillId: "trade-email-writer",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "completed",
    };
    expect(SessionMetaSchema.safeParse(raw).success).toBe(true);
  });

  it("allows null skillId (ad-hoc session without skill)", () => {
    const raw = {
      id: "abc",
      title: "x",
      skillId: null,
      createdAt: 1,
      updatedAt: 1,
      status: "active",
    };
    expect(SessionMetaSchema.safeParse(raw).success).toBe(true);
  });
});

describe("SettingsSet schema", () => {
  it("accepts arbitrary value types (unknown)", () => {
    expect(SettingsSetRequestSchema.safeParse({ key: "theme", value: "dark" }).success).toBe(true);
    expect(SettingsSetRequestSchema.safeParse({ key: "n", value: 42 }).success).toBe(true);
    expect(SettingsSetRequestSchema.safeParse({ key: "o", value: { x: 1 } }).success).toBe(true);
  });
});
