// mountMcpServer 单测：注入假 MCP client（McpClientLike），不起真实子进程。

import { describe, expect, it } from "vitest";
import { ToolHost } from "../src/host";
import { type McpClientLike, mountMcpServer } from "../src/mcp";

function fakeClient(overrides?: Partial<McpClientLike>): McpClientLike & { closed: boolean } {
  const state = { closed: false };
  return {
    listTools: async () => ({
      tools: [
        {
          name: "search",
          description: "站内搜索",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        {
          name: "post_comment",
          description: "发评论（副作用）",
          inputSchema: { type: "object" },
        },
        // 元数据里有、可执行面里没有 → 应被跳过
        { name: "ghost", inputSchema: { type: "object" } },
      ],
    }),
    tools: async () => ({
      search: {
        execute: async (input: unknown) => ({
          content: [{ type: "text", text: JSON.stringify(input) }],
        }),
      },
      post_comment: { execute: async () => ({ isError: true, content: [] }) },
    }),
    close: async () => {
      state.closed = true;
    },
    get closed() {
      return state.closed;
    },
    ...overrides,
  } as McpClientLike & { closed: boolean };
}

function allowAllHost(): ToolHost {
  return new ToolHost(async () => ({ decision: "allow" }));
}

describe("mountMcpServer", () => {
  it("命名空间注册 + readOnlyHint→safe、无标注→review、缺可执行面→跳过", async () => {
    const host = allowAllHost();
    const handle = await mountMcpServer(
      host,
      { name: "bb", command: "bb-browser", args: ["mcp"] },
      { connect: async () => fakeClient() },
    );
    expect(handle.toolNames.sort()).toEqual(["mcp:bb:post_comment", "mcp:bb:search"]);
    const byName = new Map(host.list().map((d) => [d.name, d]));
    expect(byName.get("mcp:bb:search")?.riskLevel).toBe("safe");
    expect(byName.get("mcp:bb:post_comment")?.riskLevel).toBe("review");
    expect(byName.get("mcp:bb:search")?.source).toBe("mcp");
    expect(byName.has("mcp:bb:ghost")).toBe(false);
  });

  it("执行桥接：输入透传、MCP isError 标记透传", async () => {
    const host = allowAllHost();
    await mountMcpServer(host, { name: "bb", command: "x" }, { connect: async () => fakeClient() });
    const ok = await host.execute("mcp:bb:search", { q: "usb" });
    expect(ok.isError).toBeFalsy();
    expect(JSON.stringify(ok.output)).toContain("usb");

    const bad = await host.execute("mcp:bb:post_comment", {});
    expect(bad.isError).toBe(true);
  });

  it("close() 卸载全部工具并关闭 client", async () => {
    const host = allowAllHost();
    const client = fakeClient();
    const handle = await mountMcpServer(
      host,
      { name: "bb", command: "x" },
      { connect: async () => client },
    );
    expect(host.list()).toHaveLength(2);
    await handle.close();
    expect(host.list()).toHaveLength(0);
    expect(client.closed).toBe(true);
  });

  it("挂载中途失败：回滚已注册工具并关闭子进程", async () => {
    const host = allowAllHost();
    const client = fakeClient({
      tools: async () => {
        throw new Error("handshake broke");
      },
    });
    await expect(
      mountMcpServer(host, { name: "bb", command: "x" }, { connect: async () => client }),
    ).rejects.toThrow(/handshake/);
    expect(host.list()).toHaveLength(0);
    expect(client.closed).toBe(true);
  });
});
