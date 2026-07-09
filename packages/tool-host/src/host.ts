// ToolHost：工具注册与统一执行入口。
// 不感知工具来源细节；MCP 挂载器 / 连接器加载器负责把各自工具注册进来。

import type { ToolApprovalHook, ToolDescriptor, ToolExecutionResult, ToolHandler } from "./types";

interface RegisteredTool {
  descriptor: ToolDescriptor;
  handler: ToolHandler;
}

export class ToolHost {
  private tools = new Map<string, RegisteredTool>();

  constructor(private approvalHook: ToolApprovalHook) {}

  register(descriptor: ToolDescriptor, handler: ToolHandler): void {
    if (this.tools.has(descriptor.name)) {
      throw new Error(`tool already registered: ${descriptor.name}`);
    }
    this.tools.set(descriptor.name, { descriptor, handler });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  list(): ToolDescriptor[] {
    return [...this.tools.values()].map((t) => t.descriptor);
  }

  // 统一执行：先过审批钩子，deny 不执行、原因作为错误结果返回（喂回模型）
  async execute(name: string, input: unknown): Promise<ToolExecutionResult & { denied?: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { output: `unknown tool: ${name}`, isError: true };
    }
    const verdict = await this.approvalHook(tool.descriptor, input);
    if (verdict.decision === "deny") {
      return {
        output: `tool call denied by risk gate${verdict.reason ? `: ${verdict.reason}` : ""}`,
        isError: true,
        denied: true,
      };
    }
    try {
      return await tool.handler(input);
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true };
    }
  }
}
