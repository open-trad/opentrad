// Tools 注册框架 + echo tool 测试。

import { describe, expect, it } from "vitest";
import { getToolByName, tools } from "../src/tools";
import { echoTool } from "../src/tools/echo";

describe("tools registry", () => {
  it("echo 在 tools 列表里，name / riskLevel / category 正确", () => {
    const echo = getToolByName("echo");
    expect(echo).toBe(echoTool);
    expect(echo?.name).toBe("echo");
    expect(echo?.riskLevel).toBe("safe");
    expect(echo?.category).toBe("utility");
  });

  it("getToolByName 不存在的工具返回 undefined", () => {
    expect(getToolByName("nonexistent")).toBeUndefined();
  });

  it("M1 仅注册 echo（其他工具留 #26 / #27）", () => {
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("echo");
  });
});

describe("echo tool", () => {
  // ctx 不会被 echo 用到（safe 工具不调 IPC bridge）；用 minimal stub
  const fakeCtx = { bridge: {} as never, sessionId: "test" };

  it("正确 echo 输入字符串", async () => {
    const result = await echoTool.execute({ message: "hello world" }, fakeCtx);
    expect(result).toEqual([{ type: "text", text: "OpenTrad echo: hello world" }]);
  });

  it("zod 校验：缺 message 抛错", async () => {
    await expect(echoTool.execute({}, fakeCtx)).rejects.toThrow();
  });

  it("zod 校验：message 类型错抛错", async () => {
    await expect(echoTool.execute({ message: 123 }, fakeCtx)).rejects.toThrow();
  });
});
