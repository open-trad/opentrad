// Tools 注册框架 + 各 tool 测试（M1 #25 echo + M1 #26 draft_save / hs_code_lookup
// / session_get_metadata）。

import { describe, expect, it, vi } from "vitest";
import { getToolByName, type ToolContext, tools } from "../src/tools";
import { draftSaveTool } from "../src/tools/draft-save";
import { echoTool } from "../src/tools/echo";
import { hsCodeLookupTool } from "../src/tools/hs-code-lookup";
import { sessionGetMetadataTool } from "../src/tools/session-get-metadata";

describe("tools registry", () => {
  it("7 个工具都注册（#25 echo + #26 三个 safe-only + #27 三个 browser review）", () => {
    expect(tools).toHaveLength(7);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "browser_open",
      "browser_read",
      "browser_screenshot",
      "draft_save",
      "echo",
      "hs_code_lookup",
      "session_get_metadata",
    ]);
  });

  it("getToolByName 找各工具 + miss case", () => {
    expect(getToolByName("echo")).toBe(echoTool);
    expect(getToolByName("draft_save")).toBe(draftSaveTool);
    expect(getToolByName("hs_code_lookup")).toBe(hsCodeLookupTool);
    expect(getToolByName("session_get_metadata")).toBe(sessionGetMetadataTool);
    expect(getToolByName("nonexistent")).toBeUndefined();
  });

  it("riskLevel 分布:#25 / #26 全 safe,#27 browser_* 全 review", () => {
    for (const tool of tools) {
      if (tool.name.startsWith("browser_")) {
        expect(tool.riskLevel).toBe("review");
        expect(tool.category).toBe("browser");
      } else {
        expect(tool.riskLevel).toBe("safe");
      }
    }
  });
});

describe("echo tool", () => {
  const fakeCtx: ToolContext = { bridge: {} as never, sessionId: "test" };

  it("正确 echo 输入字符串", async () => {
    const result = await echoTool.execute({ message: "hello world" }, fakeCtx);
    expect(result).toEqual([{ type: "text", text: "OpenTrad echo: hello world" }]);
  });

  it("zod 校验：缺 message 抛错", async () => {
    await expect(echoTool.execute({}, fakeCtx)).rejects.toThrow();
  });
});

describe("draft_save tool", () => {
  it("调用 bridge.draftSave + 返回 path", async () => {
    const draftSave = vi.fn().mockResolvedValue({ path: "/fake/2026-04-25-a.md" });
    const ctx = {
      bridge: { draftSave } as unknown as ToolContext["bridge"],
      sessionId: "s1",
    };

    const result = await draftSaveTool.execute({ filename: "a.md", content: "# hello" }, ctx);
    expect(draftSave).toHaveBeenCalledWith({ filename: "a.md", content: "# hello" });
    expect(result[0]?.text).toContain("/fake/2026-04-25-a.md");
  });

  it("zod 校验：filename 空字符串抛错", async () => {
    const ctx = {
      bridge: { draftSave: vi.fn() } as unknown as ToolContext["bridge"],
      sessionId: "s1",
    };
    await expect(draftSaveTool.execute({ filename: "", content: "x" }, ctx)).rejects.toThrow();
  });
});

describe("hs_code_lookup tool", () => {
  const fakeCtx: ToolContext = { bridge: {} as never, sessionId: "s1" };

  it("M1 mock 返回 3 个 candidate", async () => {
    const result = await hsCodeLookupTool.execute({ description: "无线路由器" }, fakeCtx);
    const text = result[0]?.text ?? "";
    expect(text).toContain("无线路由器");
    expect(text).toContain("8517.62");
    expect(text).toContain("8542.31");
    expect(text).toContain("9013.80");
    expect(text).toContain("M1 mock");
  });

  it("不调用 bridge（read-only mock）", async () => {
    const draftSave = vi.fn();
    const sessionMetadata = vi.fn();
    const ctx = {
      bridge: { draftSave, sessionMetadata } as unknown as ToolContext["bridge"],
      sessionId: "s1",
    };
    await hsCodeLookupTool.execute({ description: "x" }, ctx);
    expect(draftSave).not.toHaveBeenCalled();
    expect(sessionMetadata).not.toHaveBeenCalled();
  });
});

describe("session_get_metadata tool", () => {
  it("不传 sessionId 时用 ctx.sessionId（current task）", async () => {
    const sessionMetadata = vi.fn().mockResolvedValue({
      id: "current-session-id",
      title: "current",
      skillId: "fixture-skill",
      createdAt: 1000,
      updatedAt: 2000,
      status: "active",
    });
    const ctx = {
      bridge: { sessionMetadata } as unknown as ToolContext["bridge"],
      sessionId: "current-session-id",
    };

    const result = await sessionGetMetadataTool.execute({}, ctx);
    expect(sessionMetadata).toHaveBeenCalledWith({ sessionId: "current-session-id" });
    expect(result[0]?.text).toContain("current-session-id");
    expect(result[0]?.text).toContain("fixture-skill");
    expect(result[0]?.text).toContain("status: active");
  });

  it("传 sessionId 时优先用传入值", async () => {
    const sessionMetadata = vi.fn().mockResolvedValue(null);
    const ctx = {
      bridge: { sessionMetadata } as unknown as ToolContext["bridge"],
      sessionId: "current",
    };
    await sessionGetMetadataTool.execute({ sessionId: "explicit-other" }, ctx);
    expect(sessionMetadata).toHaveBeenCalledWith({ sessionId: "explicit-other" });
  });

  it("session 不存在时返回友好提示（不抛）", async () => {
    const sessionMetadata = vi.fn().mockResolvedValue(null);
    const ctx = {
      bridge: { sessionMetadata } as unknown as ToolContext["bridge"],
      sessionId: "ghost",
    };
    const result = await sessionGetMetadataTool.execute({}, ctx);
    expect(result[0]?.text).toContain("No session found");
  });
});
