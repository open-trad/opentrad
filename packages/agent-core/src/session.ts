// AgentSession：自建 agent loop（产品的大脑，ADR-001 D1）。
//
// AI SDK 版本决策（2026-07-08 核实 node_modules 实际 API 面）：
// - ai@6.0.221（npm dist-tag `ai-v6`，已 GA；npm latest 已是 v7，但 ADR-001 锁定 v6 线）
// - loop 驱动选 streamText + stopWhen（stepCountIs）而非 ToolLoopAgent 类：
//   ToolLoopAgent 是同一循环的薄封装，直接用 streamText 拿到 fullStream 逐 part 转译
//   AgentEvent 更直接，也便于按步做预算硬顶与 checkpoint。切换成本极低。
// - 逃生门约束：AI SDK 类型全部封在本文件内，不出包边界。
//
// 上下文管理 M0 从简：仅完整历史（每轮把 response.messages 追加进 this.messages），
// 滑动窗口截断 + 超阈值单次摘要留 M1（见重启计划"刻意做笨"）。

import type { AgentEvent } from "@opentrad/shared";
import {
  dynamicTool,
  type JSONSchema7,
  jsonSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai";
import type { AgentEventListener, AgentSessionConfig, AgentSessionHandle } from "./types";

type SessionResultSubtype = "success" | "error" | "aborted" | "budget_exceeded" | "max_steps";

// 工具名净化：provider API（Anthropic/OpenAI）只接受 [a-zA-Z0-9_-]，
// 而 ToolHost 的 MCP 命名空间用冒号（"mcp:<server>:<tool>"）。
// 送给模型的键做净化，事件与 ToolHost.execute 始终用原始名（净化→原始反查表见 buildTools）。
function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

class AgentSession implements AgentSessionHandle {
  readonly sessionId: string;

  private listeners = new Set<AgentEventListener>();
  // 完整消息历史（M0：不截断不摘要）
  private messages: ModelMessage[] = [];
  private abortController: AbortController | null = null;
  private userAborted = false;
  private running = false;
  private ended = false;
  // 跨 send 轮次累计（maxSteps 与预算都是"单会话"口径）
  private stepCount = 0;
  private totalCostUsd: number | null = null;
  private startEmitted = false;
  private msgSeq = 0;

  constructor(private readonly config: AgentSessionConfig) {
    this.sessionId = config.sessionId;
  }

  onEvent(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  abort(): void {
    this.userAborted = true;
    this.ended = true;
    if (this.running) {
      this.abortController?.abort();
    } else {
      // 空闲中止：直接收尾（无进行中的轮次可打断）
      this.emitResult("aborted", 0);
    }
  }

  // 发送一条用户消息并驱动 loop 直到本轮结束（工具循环在内部完成）。
  // 事件语义：agent_session_start 整个会话只发一次；agent_session_result 每轮结束发一次。
  async send(userMessage: string): Promise<void> {
    if (this.running) throw new Error(`session ${this.sessionId}: already processing a message`);
    if (this.ended) throw new Error(`session ${this.sessionId}: session has ended`);
    this.running = true;
    const startedAt = Date.now();
    const roundBase = this.stepCount;
    this.abortController = new AbortController();
    this.messages.push({ role: "user", content: userMessage });

    const { tools, originalNames } = this.buildTools();
    if (!this.startEmitted) {
      this.startEmitted = true;
      this.emit({
        type: "agent_session_start",
        sessionId: this.sessionId,
        profileId: this.config.backend.profileId,
        model: this.config.model ?? "unknown",
        tools: [...originalNames.values()],
      });
    }

    // 步数额度已耗尽：不再发起模型调用，直接按 max_steps 收尾
    const remainingSteps = this.config.maxSteps - this.stepCount;
    if (remainingSteps <= 0) {
      this.running = false;
      this.ended = true;
      this.emitResult("max_steps", Date.now() - startedAt);
      return;
    }

    let subtype: SessionResultSubtype = "success";
    let errorMessage: string | undefined;
    let budgetExceeded = false;
    let lastFinishReason: string | undefined;

    try {
      // 底层模型句柄由 ChatBackend 提供（对外 unknown，进本包边界后收窄为 LanguageModel）
      const model = (await this.config.backend.resolveModel()) as LanguageModel;
      const result = streamText({
        model,
        system: this.config.systemPrompt,
        messages: this.messages,
        tools,
        stopWhen: stepCountIs(remainingSteps),
        abortSignal: this.abortController.signal,
        // 错误经 fullStream 的 error part 统一处理，这里只抑制默认 console 输出
        onError: () => {},
        onStepFinish: async (step) => {
          // 每步落 checkpoint：最小可恢复状态 = 完整消息历史快照
          await this.config.checkpoints?.save(this.sessionId, roundBase + step.stepNumber + 1, {
            messages: [...this.messages, ...step.response.messages],
          });
        },
      });

      let currentMsgId = "";
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "start-step":
            this.msgSeq += 1;
            currentMsgId = `${this.sessionId}#m${this.msgSeq}`;
            break;
          case "text-delta":
            this.emit({
              type: "agent_text",
              sessionId: this.sessionId,
              msgId: currentMsgId,
              delta: part.text,
              done: false,
            });
            break;
          case "text-end":
            this.emit({
              type: "agent_text",
              sessionId: this.sessionId,
              msgId: currentMsgId,
              delta: "",
              done: true,
            });
            break;
          case "reasoning-delta":
            this.emit({
              type: "agent_thinking",
              sessionId: this.sessionId,
              msgId: currentMsgId,
              delta: part.text,
              done: false,
            });
            break;
          case "reasoning-end":
            this.emit({
              type: "agent_thinking",
              sessionId: this.sessionId,
              msgId: currentMsgId,
              delta: "",
              done: true,
            });
            break;
          case "tool-call":
            // loop 已决定调用、尚未执行；审批与执行都在 ToolHost 内完成
            this.emit({
              type: "agent_tool_call",
              sessionId: this.sessionId,
              msgId: currentMsgId,
              toolCallId: part.toolCallId,
              toolName: originalNames.get(part.toolName) ?? part.toolName,
              input: part.input,
            });
            break;
          // tool 执行结果事件在 buildTools 的 execute 桥接内发出（保真 denied 标记），此处不重复
          case "finish-step": {
            this.stepCount += 1;
            lastFinishReason = part.finishReason;
            const inputTokens = part.usage.inputTokens ?? 0;
            const outputTokens = part.usage.outputTokens ?? 0;
            const pricing = this.config.pricing ?? null;
            const cost = pricing
              ? (inputTokens / 1e6) * pricing.inputPerMTokUsd +
                (outputTokens / 1e6) * pricing.outputPerMTokUsd
              : null;
            if (cost != null) this.totalCostUsd = (this.totalCostUsd ?? 0) + cost;
            this.emit({
              type: "agent_usage",
              sessionId: this.sessionId,
              msgId: currentMsgId,
              usage: {
                inputTokens,
                outputTokens,
                cacheCreationInputTokens: part.usage.inputTokenDetails.cacheWriteTokens,
                cacheReadInputTokens: part.usage.inputTokenDetails.cacheReadTokens,
              },
              estimatedCostUsd: cost,
            });
            // 预算硬顶：达到/超过即中止 loop（下一步可能已在途，中止信号立即生效）
            if (
              this.config.budgetUsd != null &&
              this.totalCostUsd != null &&
              this.totalCostUsd >= this.config.budgetUsd
            ) {
              budgetExceeded = true;
              this.abortController?.abort();
            }
            break;
          }
          case "error":
            subtype = "error";
            errorMessage = part.error instanceof Error ? part.error.message : String(part.error);
            break;
          default:
            break;
        }
      }

      if (subtype !== "error") {
        if (this.userAborted) {
          subtype = "aborted";
        } else if (budgetExceeded) {
          subtype = "budget_exceeded";
        } else {
          // 正常收尾：把本轮 assistant/tool 消息并入完整历史
          const response = await result.response;
          this.messages.push(...response.messages);
          // stopWhen 截停时最后一步仍在要求工具调用 → 判定为步数上限终止
          subtype =
            this.stepCount >= this.config.maxSteps && lastFinishReason === "tool-calls"
              ? "max_steps"
              : "success";
        }
      }
    } catch (err) {
      if (this.userAborted) {
        subtype = "aborted";
      } else if (budgetExceeded) {
        subtype = "budget_exceeded";
      } else {
        subtype = "error";
        errorMessage = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.running = false;
      if (subtype !== "success") this.ended = true;
      this.emitResult(subtype, Date.now() - startedAt, errorMessage);
    }
  }

  // 把 ToolHost 里（经 allowedTools 过滤后）的工具桥接成 AI SDK 工具定义。
  // inputSchema 为 JSON Schema 原样透传；执行必须走 toolHost.execute（审批在其内完成）。
  private buildTools(): { tools: ToolSet; originalNames: Map<string, string> } {
    const allowed = this.config.allowedTools;
    const descriptors = this.config.toolHost
      .list()
      .filter((d) => !allowed || allowed.includes(d.name));
    const tools: ToolSet = {};
    // 净化名 → 原始名反查表（冲突时后写覆盖：M0 接受，见遗留问题）
    const originalNames = new Map<string, string>();
    for (const descriptor of descriptors) {
      const modelFacingName = sanitizeToolName(descriptor.name);
      originalNames.set(modelFacingName, descriptor.name);
      tools[modelFacingName] = dynamicTool({
        description: descriptor.description,
        inputSchema: jsonSchema(descriptor.inputSchema as JSONSchema7),
        execute: async (input, { toolCallId }) => {
          const result = await this.config.toolHost.execute(descriptor.name, input);
          this.emit({
            type: "agent_tool_result",
            sessionId: this.sessionId,
            toolCallId,
            toolName: descriptor.name,
            output: result.output,
            isError: result.isError,
            denied: result.denied,
          });
          if (result.isError) {
            // deny/执行失败不抛异常：以普通 tool result 喂回模型，让 loop 自愈而非崩溃
            return {
              error: true,
              denied: result.denied === true,
              message: String(result.output),
            };
          }
          return result.output;
        },
      });
    }
    return { tools, originalNames };
  }

  private emitResult(subtype: SessionResultSubtype, durationMs: number, errorMessage?: string) {
    this.emit({
      type: "agent_session_result",
      sessionId: this.sessionId,
      subtype,
      durationMs,
      numSteps: this.stepCount,
      totalCostUsd: this.totalCostUsd,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    });
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export function createAgentSession(config: AgentSessionConfig): AgentSessionHandle {
  return new AgentSession(config);
}
