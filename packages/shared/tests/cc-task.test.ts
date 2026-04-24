import { describe, expect, it } from "vitest";
import { CCResultSchema, CCTaskOptionsSchema } from "../src";

describe("CCTaskOptions schema", () => {
  it("accepts minimum required fields", () => {
    const raw = {
      sessionId: "abc",
      prompt: "Say hi",
      mcpConfigPath: "/tmp/x.json",
      allowedTools: ["Read"],
    };
    expect(CCTaskOptionsSchema.safeParse(raw).success).toBe(true);
  });

  it("accepts all optional fields populated", () => {
    const raw = {
      sessionId: "abc",
      prompt: "Say hi",
      mcpConfigPath: "/tmp/x.json",
      allowedTools: ["Read"],
      cwd: "/home/user",
      model: "sonnet",
      permissionMode: "acceptEdits",
      resume: true,
    };
    expect(CCTaskOptionsSchema.safeParse(raw).success).toBe(true);
  });

  it("rejects unknown model name", () => {
    const raw = {
      sessionId: "abc",
      prompt: "Say hi",
      mcpConfigPath: "/tmp/x.json",
      allowedTools: [],
      model: "gpt-5",
    };
    expect(CCTaskOptionsSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects missing required field (prompt only)", () => {
    const raw = { prompt: "x" };
    expect(CCTaskOptionsSchema.safeParse(raw).success).toBe(false);
  });
});

describe("CCResult schema", () => {
  it("parses a valid success result", () => {
    const raw = {
      sessionId: "abc",
      status: "success",
      data: { costUsd: 0.01 },
      exitCode: 0,
    };
    expect(CCResultSchema.safeParse(raw).success).toBe(true);
  });

  it("rejects non-integer exitCode", () => {
    const raw = {
      sessionId: "abc",
      status: "error",
      data: {},
      exitCode: 1.5,
    };
    expect(CCResultSchema.safeParse(raw).success).toBe(false);
  });
});
