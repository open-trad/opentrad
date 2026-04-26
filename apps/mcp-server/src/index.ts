// OpenTrad MCP Server 入口（M1 #25 / open-trad/opentrad#25）。
// 由 CC 通过 stdio 拉起（参见 mcp-config 配置生成在 desktop 主进程的 McpConfigWriter，
// M1 #26 落地）。本进程：
// 1. stdio MCP server 暴露 tools 给 CC
// 2. IPC bridge client 连 desktop 主进程，调 risk-gate.request / audit.log /
//    draft.save / session.metadata 4 个 RPC
//
// 启动参数：从 env 读 OPENTRAD_IPC_SOCKET 和 OPENTRAD_SESSION_ID。
//
// 关键约束：
// - **stdout 不能 console.log**（污染 stdio MCP wire 流）。诊断输出走 stderr。
// - 启动失败 / IPC 连不上不阻塞 stdio MCP（graceful degrade，echo 类 safe tool 仍可用）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BrowserService } from "@opentrad/browser-tools";
import { z } from "zod";
import { IpcBridgeClient } from "./ipc-bridge";
import { runRiskGate } from "./middleware/risk-gate";
import { getToolByName, tools } from "./tools";

async function main(): Promise<void> {
  const sessionId = process.env.OPENTRAD_SESSION_ID;
  const socketPath = process.env.OPENTRAD_IPC_SOCKET;

  if (!sessionId) {
    process.stderr.write("[opentrad-mcp] missing OPENTRAD_SESSION_ID env\n");
    process.exit(1);
  }
  if (!socketPath) {
    process.stderr.write("[opentrad-mcp] missing OPENTRAD_IPC_SOCKET env\n");
    process.exit(1);
  }

  // IPC bridge：异步连接（不阻塞 stdio MCP server 启动；连不上走 offline graceful degrade）
  const bridge = new IpcBridgeClient({
    sessionId,
    socketPath,
    mcpServerPid: process.pid,
  });
  void bridge.connect();

  // BrowserService(M1 #27):懒加载 Chromium,首次 browser_open 时才启。
  // dev 模式 chromium binary 在 ~/Library/Caches/ms-playwright/(发起人首次跑 setup);
  // packaged 模式 PLAYWRIGHT_BROWSERS_PATH env 由 desktop 主进程注入(M1 #30)。
  const browserService = new BrowserService({ launchOptions: { headless: false } });

  // RiskGate(M1 #28):MockRiskGate 已删,所有 review-level tool 走 IPC bridge 调
  // desktop 端真实 RiskGate.check(用户弹窗 + audit_log + 5min 超时)。
  // middleware 在 CallToolRequest handler 内调 runRiskGate(...)。

  const server = new Server(
    { name: "opentrad", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = getToolByName(req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
      };
    }

    // RiskGate middleware(M1 #28):blocked → 直接拒;review → 走 IPC bridge 调
    // desktop 端真实 RiskGate.check;safe → bypass。详见 middleware/risk-gate.ts。
    const gateDecision = await runRiskGate({
      bridge,
      tool,
      toolArgs: req.params.arguments,
      sessionId,
    });
    if (!gateDecision.allowed) {
      return {
        isError: true,
        content: [{ type: "text", text: gateDecision.reason ?? `risk gate denied ${tool.name}` }],
      };
    }

    try {
      const content = await tool.execute(req.params.arguments ?? {}, {
        bridge,
        sessionId,
        browserService,
      });
      return { content };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 退出清理：CC 关闭 stdio 时 SDK 会触发；这里再加一道 cleanup 保险
  const shutdown = (): void => {
    void browserService.cleanup().catch(() => {});
    bridge.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// 把 zod schema 投影到 MCP SDK 期望的 JSON Schema 形态。
// MCP 协议要求 inputSchema 是 { type: "object", properties: {...}, required: [...] } 形态。
// 这里手写一个最小映射器，避免引入 zod-to-json-schema 第三方依赖（M1 工具简单够用；
// M1 #27 浏览器工具有更复杂参数时可视情况换成 zod-to-json-schema）。
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, fieldSchema] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(fieldSchema);
      if (!fieldSchema.isOptional()) required.push(key);
    }
    return { type: "object", properties, required };
  }
  if (schema instanceof z.ZodString) {
    return schema.description
      ? { type: "string", description: schema.description }
      : { type: "string" };
  }
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodArray) {
    // M1 范围内的 echo tool 不用 array；后续 M1 #26 / #27 复杂参数时升级到
    // zod-to-json-schema 第三方包（zod v4 内部类型在简单递归里不稳）。
    return { type: "array" };
  }
  // 兜底：unknown 类型，CC 不会报错
  return { type: "string" };
}

main().catch((err) => {
  process.stderr.write(`[opentrad-mcp] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
