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
  // 注：data 字段对应 ResultDataSchema（D5 拍板：按 fixture 收紧为必填
  // durationMs/numTurns/totalCostUsd/isError/uuid）
  const minimalResultData = {
    durationMs: 2318,
    numTurns: 1,
    totalCostUsd: 0.0074389,
    isError: false,
    uuid: "u1",
  };

  it("parses a valid success result", () => {
    const raw = {
      sessionId: "abc",
      status: "success",
      data: minimalResultData,
      exitCode: 0,
    };
    expect(CCResultSchema.safeParse(raw).success).toBe(true);
  });

  it("accepts cancelled status (user-initiated kill)", () => {
    const raw = {
      sessionId: "abc",
      status: "cancelled",
      data: minimalResultData,
      exitCode: 130,
    };
    expect(CCResultSchema.safeParse(raw).success).toBe(true);
  });

  it("rejects unknown status value", () => {
    const raw = {
      sessionId: "abc",
      status: "timeout",
      data: minimalResultData,
      exitCode: 1,
    };
    expect(CCResultSchema.safeParse(raw).success).toBe(false);
  });

  it("rejects non-integer exitCode", () => {
    const raw = {
      sessionId: "abc",
      status: "error",
      data: minimalResultData,
      exitCode: 1.5,
    };
    expect(CCResultSchema.safeParse(raw).success).toBe(false);
  });
});
