import { describe, expect, it } from "vitest";
import { ToolHost } from "../src/host";
import type { ToolDescriptor } from "../src/types";

const echoTool: ToolDescriptor = {
  name: "echo",
  description: "echo input back",
  inputSchema: { type: "object" },
  source: "builtin",
  riskLevel: "safe",
};

const publishTool: ToolDescriptor = {
  name: "shopify.publish_listing",
  description: "publish a listing",
  inputSchema: { type: "object" },
  source: "connector",
  riskLevel: "review",
  businessAction: "publish_listing",
};

describe("ToolHost", () => {
  it("执行 allow 的工具并返回结果", async () => {
    const host = new ToolHost(async () => ({ decision: "allow" }));
    host.register(echoTool, async (input) => ({ output: input }));
    const result = await host.execute("echo", { hello: 1 });
    expect(result.output).toEqual({ hello: 1 });
    expect(result.isError).toBeUndefined();
  });

  it("deny 时不执行 handler，拒绝原因作为错误结果返回", async () => {
    let executed = false;
    const host = new ToolHost(async (tool) =>
      tool.businessAction === "publish_listing"
        ? { decision: "deny", reason: "stopBefore: user confirmation required" }
        : { decision: "allow" },
    );
    host.register(publishTool, async () => {
      executed = true;
      return { output: "published" };
    });
    const result = await host.execute("shopify.publish_listing", {});
    expect(executed).toBe(false);
    expect(result.denied).toBe(true);
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain("stopBefore");
  });

  it("未知工具返回错误而不抛异常（喂回模型自愈）", async () => {
    const host = new ToolHost(async () => ({ decision: "allow" }));
    const result = await host.execute("nope", {});
    expect(result.isError).toBe(true);
  });

  it("handler 抛异常转为错误结果", async () => {
    const host = new ToolHost(async () => ({ decision: "allow" }));
    host.register(echoTool, async () => {
      throw new Error("boom");
    });
    const result = await host.execute("echo", {});
    expect(result.isError).toBe(true);
    expect(result.output).toBe("boom");
  });

  it("重复注册同名工具抛错", () => {
    const host = new ToolHost(async () => ({ decision: "allow" }));
    host.register(echoTool, async () => ({ output: null }));
    expect(() => host.register(echoTool, async () => ({ output: null }))).toThrow(
      /already registered/,
    );
  });
});
