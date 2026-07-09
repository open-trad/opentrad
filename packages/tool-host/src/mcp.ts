// MCP server 挂载器：把外部 stdio MCP server 的工具注册进 ToolHost。
// 这是 day-1 的 DIY 主通道（用户自挂任意 MCP server；bb-browser 也由此接入，见 ADR-001 D4）。
//
// 依赖决策（2026-07-08 核实 node_modules 实际 API 面）：
// - MCP client 用 @ai-sdk/mcp@1.0.60（npm dist-tag `ai-v6`，与 ai@6.0.221 同线）：
//   createMCPClient({ transport }) + Experimental_StdioMCPTransport（@ai-sdk/mcp/mcp-stdio 子路径导出）
// - ai 包内旧的 experimental_createMCPClient 在 v6 已拆到独立包 @ai-sdk/mcp，本实现以后者为准
// - 逃生门约束：@ai-sdk/mcp 的类型不出包边界——对外只暴露我们自己的结构化接口

import { createMCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport as StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolHost } from "./host";
import type { ToolDescriptor, ToolExecutionResult } from "./types";

// stdio MCP server 启动配置
export interface McpServerConfig {
  // 命名空间名（工具注册为 "mcp:<name>:<tool>"）
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

// MCP 工具定义（listTools 返回的元数据子集；inputSchema 为 JSON Schema 原样透传）
interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: unknown;
  // MCP 标准 annotations：readOnlyHint=true 表示只读工具
  annotations?: { readOnlyHint?: boolean } & Record<string, unknown>;
}

// 可执行工具面（client.tools() 产物的最小子集）
interface McpExecutableTool {
  execute(
    input: unknown,
    options: { toolCallId: string; messages: never[] },
  ): PromiseLike<unknown> | unknown;
}

// 最小 MCP client 接口：mountMcpServer 只依赖这三个方法。
// 真实实现来自 @ai-sdk/mcp 的 createMCPClient；单测注入假实现。
export interface McpClientLike {
  listTools(): Promise<{ tools: McpToolDefinition[] }>;
  tools(): Promise<Record<string, McpExecutableTool>>;
  close(): Promise<void>;
}

// 挂载句柄：desktop 侧持有，用于卸载（unregister 全部工具 + 关闭 client 子进程）
export interface McpMountHandle {
  serverName: string;
  toolNames: string[];
  close(): Promise<void>;
}

// 真实连接器：启动 stdio 子进程并完成 MCP 初始化握手
async function connectStdio(config: McpServerConfig): Promise<McpClientLike> {
  const client = await createMCPClient({
    transport: new StdioMCPTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    }),
  });
  // 适配为最小接口（真实 client 的方法参数是可选超集，结构兼容）
  return {
    listTools: () => client.listTools(),
    tools: () => client.tools(),
    close: () => client.close(),
  };
}

let bridgeCallSeq = 0;

// 把一个 MCP server 的全部工具注册进 ToolHost。
// riskLevel 规则：MCP 元数据可判只读（annotations.readOnlyHint === true）→ safe；其余默认 review。
// options.connect 仅供测试注入假 client；生产走默认 stdio 连接。
export async function mountMcpServer(
  host: ToolHost,
  config: McpServerConfig,
  options?: { connect?: (config: McpServerConfig) => Promise<McpClientLike> },
): Promise<McpMountHandle> {
  const client = await (options?.connect ?? connectStdio)(config);
  const registered: string[] = [];
  try {
    const { tools: definitions } = await client.listTools();
    const executable = await client.tools();
    for (const def of definitions) {
      const impl = executable[def.name];
      // client.tools() 可能过滤掉 schema 非法的工具；元数据与可执行面取交集
      if (!impl) continue;
      const namespaced = `mcp:${config.name}:${def.name}`;
      const descriptor: ToolDescriptor = {
        name: namespaced,
        description: def.description ?? "",
        inputSchema: def.inputSchema,
        source: "mcp",
        riskLevel: def.annotations?.readOnlyHint === true ? "safe" : "review",
      };
      host.register(descriptor, async (input): Promise<ToolExecutionResult> => {
        bridgeCallSeq += 1;
        const output = await impl.execute(input, {
          toolCallId: `toolhost_${bridgeCallSeq}`,
          messages: [],
        });
        // MCP CallToolResult 自带 isError 标记；原样透传给 ToolHost 消费方
        const isError =
          typeof output === "object" &&
          output !== null &&
          (output as { isError?: boolean }).isError === true;
        return { output, isError };
      });
      registered.push(namespaced);
    }
  } catch (err) {
    // 挂载中途失败：回滚已注册工具并关闭子进程，不留半挂载状态
    for (const name of registered) host.unregister(name);
    await client.close().catch(() => {});
    throw err;
  }
  return {
    serverName: config.name,
    toolNames: registered,
    close: async () => {
      for (const name of registered) host.unregister(name);
      await client.close();
    },
  };
}
