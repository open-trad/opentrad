// wire → domain 显式映射（按发起人 D1=B' / D6=X / D6a 拍板）。
// 输入 wire 层 schema 化后的 WireCCEvent，产出 0-N 个 domain CCEvent：
// - system/rate_limit/result：1→1 直接字段改名 + 挑选
// - assistant：1→N 按 content block 扁平化，metadata 挂最后一个事件（isLast=true）
//
// 设计不变量：
// - 每个 domain 事件都带 msgId / seq / sessionId / uuid（D6e）
// - thinking block 的 signature 保留（D6b）
// - parent_tool_use_id 暂忽略（D6d，v1 不需要）

import type {
  CCEvent,
  MessageMeta,
  Usage,
  WireAssistantEvent,
  WireCCEvent,
  WireContentBlock,
  WireMcpServerInfo,
  WireRateLimitEvent,
  WireResultEvent,
  WireSystemInitEvent,
  WireUsage,
} from "@opentrad/shared";

export function* normalizeWireEvent(wire: WireCCEvent): Generator<CCEvent> {
  switch (wire.type) {
    case "system":
      yield normalizeSystemInit(wire);
      return;
    case "assistant":
      yield* normalizeAssistant(wire);
      return;
    case "rate_limit_event":
      yield normalizeRateLimit(wire);
      return;
    case "result":
      yield normalizeResult(wire);
      return;
  }
}

function normalizeMcpServer(wire: WireMcpServerInfo) {
  return { name: wire.name, status: wire.status };
}

function normalizeSystemInit(wire: WireSystemInitEvent): CCEvent {
  return {
    type: "system",
    subtype: "init",
    data: {
      cwd: wire.cwd,
      sessionId: wire.session_id,
      tools: wire.tools,
      mcpServers: wire.mcp_servers.map(normalizeMcpServer),
      model: wire.model,
      permissionMode: wire.permissionMode,
      slashCommands: wire.slash_commands,
      apiKeySource: wire.apiKeySource,
      claudeCodeVersion: wire.claude_code_version,
      outputStyle: wire.output_style,
      agents: wire.agents,
      skills: wire.skills,
      uuid: wire.uuid,
    },
  };
}

function normalizeUsage(wire: WireUsage): Usage {
  return {
    inputTokens: wire.input_tokens,
    outputTokens: wire.output_tokens,
    cacheCreationInputTokens: wire.cache_creation_input_tokens,
    cacheReadInputTokens: wire.cache_read_input_tokens,
  };
}

// 1 个 wire assistant event → N 个 domain events（按 content block 数量）。
// metadata 挂最后一个 event 的 messageMeta 字段，isLast=true。
function* normalizeAssistant(wire: WireAssistantEvent): Generator<CCEvent> {
  const blocks = wire.message.content;
  const msgId = wire.message.id;
  const sessionId = wire.session_id;
  const uuid = wire.uuid;
  const meta: MessageMeta = {
    model: wire.message.model,
    usage: normalizeUsage(wire.message.usage),
    stopReason: wire.message.stop_reason ?? null,
  };
  const lastIdx = blocks.length - 1;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    const isLast = i === lastIdx;
    const messageMeta = isLast ? meta : undefined;
    yield blockToDomainEvent(block, {
      msgId,
      seq: i,
      sessionId,
      uuid,
      isLast,
      messageMeta,
    });
  }
}

interface BlockBase {
  msgId: string;
  seq: number;
  sessionId: string;
  uuid: string;
  isLast: boolean;
  messageMeta: MessageMeta | undefined;
}

function blockToDomainEvent(block: WireContentBlock, base: BlockBase): CCEvent {
  switch (block.type) {
    case "text":
      return {
        type: "assistant_text",
        msgId: base.msgId,
        seq: base.seq,
        sessionId: base.sessionId,
        uuid: base.uuid,
        isLast: base.isLast,
        messageMeta: base.messageMeta,
        text: block.text,
      };
    case "thinking":
      return {
        type: "assistant_thinking",
        msgId: base.msgId,
        seq: base.seq,
        sessionId: base.sessionId,
        uuid: base.uuid,
        isLast: base.isLast,
        messageMeta: base.messageMeta,
        thinking: block.thinking,
        signature: block.signature,
      };
    case "tool_use":
      return {
        type: "assistant_tool_use",
        msgId: base.msgId,
        seq: base.seq,
        sessionId: base.sessionId,
        uuid: base.uuid,
        isLast: base.isLast,
        messageMeta: base.messageMeta,
        toolUseId: block.id,
        name: block.name,
        input: block.input,
      };
    case "tool_result":
      // 防御路径：assistant message 理论上不含 tool_result block（规范上属 user message）。
      // TODO(issue-5): 抓真实 tool-use fixture 后确认 CC 的 wire 发法。
      return {
        type: "tool_result",
        msgId: base.msgId,
        seq: base.seq,
        sessionId: base.sessionId,
        uuid: base.uuid,
        toolUseId: block.tool_use_id,
        content: block.content,
        isError: block.is_error,
      };
  }
}

function normalizeRateLimit(wire: WireRateLimitEvent): CCEvent {
  return {
    type: "rate_limit_event",
    sessionId: wire.session_id,
    uuid: wire.uuid,
    rateLimitInfo: {
      status: wire.rate_limit_info.status,
      resetsAt: wire.rate_limit_info.resetsAt,
      rateLimitType: wire.rate_limit_info.rateLimitType,
      overageStatus: wire.rate_limit_info.overageStatus,
      overageDisabledReason: wire.rate_limit_info.overageDisabledReason,
      isUsingOverage: wire.rate_limit_info.isUsingOverage,
    },
  };
}

function normalizeResult(wire: WireResultEvent): CCEvent {
  return {
    type: "result",
    subtype: wire.subtype,
    sessionId: wire.session_id,
    data: {
      durationMs: wire.duration_ms,
      durationApiMs: wire.duration_api_ms,
      numTurns: wire.num_turns,
      result: wire.result,
      stopReason: wire.stop_reason ?? undefined,
      totalCostUsd: wire.total_cost_usd,
      isError: wire.is_error,
      terminalReason: wire.terminal_reason,
      fastModeState: wire.fast_mode_state,
      uuid: wire.uuid,
      modelUsage: wire.modelUsage,
    },
  };
}
