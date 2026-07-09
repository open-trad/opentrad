// 工具宿主层核心契约（ADR-001）。
// 三类工具统一挂载：内建（web/文件/browser-tools）、连接器动作、MCP client 挂载的外部工具。
// 每个工具带 riskLevel + businessAction 元数据，执行前统一过 risk-gate——这是与旧架构
// （隔着 Claude Code 只能靠 MCP 间接约束）最大的能力差：loop 是我们的，闸门是硬的。

import type { RiskLevel } from "@opentrad/shared";
import { z } from "zod";

export const ToolSourceSchema = z.enum(["builtin", "connector", "mcp"]);
export type ToolSource = z.infer<typeof ToolSourceSchema>;

export interface ToolDescriptor {
  // 全局唯一名（mcp 来源用 "mcp:<server>:<tool>" 命名空间避免碰撞）
  name: string;
  description: string;
  // JSON Schema（MCP 工具原样透传；内建/连接器工具由 zod 转换）
  inputSchema: unknown;
  source: ToolSource;
  riskLevel: RiskLevel;
  // 业务级动作标识（如 "publish_listing"）；risk-gate 的 stopBefore 规则按此匹配
  businessAction?: string;
}

export interface ToolExecutionResult {
  output: unknown;
  isError?: boolean;
}

export type ToolHandler = (input: unknown) => Promise<ToolExecutionResult>;

// 执行前审批钩子：由 desktop 注入 risk-gate 检查（弹窗审批/stopBefore/审计）。
// 返回 deny 时工具不执行，拒绝原因作为 tool result 喂回模型（loop 自愈而非崩溃）。
export type ToolApprovalHook = (
  tool: ToolDescriptor,
  input: unknown,
) => Promise<{ decision: "allow" | "deny"; reason?: string }>;
