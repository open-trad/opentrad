// agent-core 核心契约（ADR-001）。
// 本包硬约束 <2,500 行（不含测试）——上下文管理刻意做笨（滑动窗口截断 + 超阈值单次摘要），
// 不做向量记忆、不做多 agent 编排、不做自主规划器（见重启计划"不做清单"）。
// AI SDK 等底层依赖封在本包内部不外泄：升级隔离 + 保留切换 pi-agent-core 的逃生门。

import type { ChatBackend } from "@opentrad/model-providers";
import type { AgentEvent } from "@opentrad/shared";
import type { ToolHost } from "@opentrad/tool-host";

export interface AgentSessionConfig {
  sessionId: string;
  backend: ChatBackend;
  toolHost: ToolHost;
  // skill 合成的 system prompt（skill-runtime 产出）；无 skill 时用默认
  systemPrompt?: string;
  // skill manifest 声明的 allowedTools 过滤；undefined = 全部已注册工具
  allowedTools?: string[];
  // 单会话步数上限（loop 安全阀）
  maxSteps: number;
  // 单会话成本硬顶（USD）；超出立即终止并发 session_result subtype=budget_exceeded
  budgetUsd: number | null;
  // 模型名（来自选定 ProviderProfile.model）：session_start 事件展示用；缺省 "unknown"
  model?: string;
  // 定价（来自选定 ProviderProfile.pricing）：每步 usage 成本估算用；null/缺省 = 定价未知，
  // 此时 estimatedCostUsd 为 null 且预算硬顶无法生效（M1 考虑对未知定价拒绝设置预算）
  pricing?: { inputPerMTokUsd: number; outputPerMTokUsd: number } | null;
  // 每步后落 checkpoint（desktop 侧 SQLite 实现，M1 接线）；缺省不落
  checkpoints?: CheckpointStore;
}

export type AgentEventListener = (event: AgentEvent) => void;

// 会话句柄：desktop 主进程（M0 spike）/ utilityProcess（M1）持有
export interface AgentSessionHandle {
  readonly sessionId: string;
  // 发送一条用户消息并驱动 loop 直到本轮结束（工具循环在内部完成）
  send(userMessage: string): Promise<void>;
  // 用户中止：产生 session_result subtype=aborted
  abort(): void;
  onEvent(listener: AgentEventListener): () => void;
}

// checkpoint 存取接口：desktop 侧用 SQLite 实现（M1），测试用内存实现。
// 每步落 checkpoint，崩溃后可从最近 checkpoint 恢复会话上下文。
export interface CheckpointStore {
  save(sessionId: string, step: number, state: unknown): Promise<void>;
  loadLatest(sessionId: string): Promise<{ step: number; state: unknown } | null>;
}
