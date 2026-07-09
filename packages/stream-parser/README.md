# @opentrad/stream-parser

Claude Code stream-json (NDJSON) → OpenTrad domain 事件流的解析器。

## 职责

- 行级 NDJSON 缓冲与切分(`parser.ts`)
- wire 层 zod 校验(`WireCCEvent`,在 `@opentrad/shared`)
- wire → domain 显式映射(`normalize.ts`):字段 camelCase 化 + assistant 1→N 扁平化
- 任何失败(非 JSON 行、wire schema 不匹配、未知 type)→ `unknown` domain 事件兜底,不丢数据

## 公开 API

```ts
import { StreamParser } from "@opentrad/stream-parser";
import type { CCEvent } from "@opentrad/shared";

const parser = new StreamParser();

// 子进程 stdout 喂入 chunk,yield 出可完整解析的 CCEvent
ccStdout.on("data", (chunk: string) => {
  for (const event of parser.parseChunk(chunk)) {
    handleEvent(event);
  }
});

// 流结束(子进程退出)时
ccStdout.on("end", () => {
  for (const event of parser.flush()) {
    handleEvent(event);
  }
});
```

## Consumer guide:如何判断 message 真的说完

`isLast=true` 与 `messageMeta` 是 **per-wire-event 语义**:CC 2.1.119 实测每个 content block 是一个独立 wire `assistant` event,所以 `normalize` 函数 1→N 中的 N 通常等于 1。这意味着:

- **`isLast=true` 仅表示"本 wire event 内最后一个 block 的 domain 事件"**,不等同"整条逻辑消息真的说完"
- **`messageMeta` 是 per-wire-event 快照**——`usage` / `stopReason` 反映这个 wire event 截至此刻的 message-level 累计状态,**不**是整条消息的最终值

要判断"消息真的说完"(例如 UI 关闭 streaming 动画 / 关闭对话气泡 / 入库结算),消费方应观察以下三个锚点中的任一个。

### 锚点 1:同 msgId 后跟 `tool_result`

CC 调用工具后,会发送 `tool_result` 事件。如果一条 assistant message 以 `tool_use` 结尾(模型决定调用工具),则 `tool_result` 到达可视为"该 message 已切换到工具结果阶段,assistant 这一轮说完了"。

```ts
for (const event of parser.parseChunk(chunk)) {
  if (event.type === "tool_result") {
    // 上一个 assistant message 已结束(进入工具结果阶段)
    closeAssistantBubble(event.msgId);
  }
}
```

### 锚点 2:`result` 事件到达

`result` 事件表示整个 task 结束,携带 `stopReason` / `totalCostUsd` / `durationMs` 等终态字段。这是最强信号——message 和整个 task 都说完。

```ts
for (const event of parser.parseChunk(chunk)) {
  if (event.type === "result") {
    finalizeTask(event.sessionId, event.data.totalCostUsd, event.data.durationMs);
  }
}
```

### 锚点 3:新 msgId 的 assistant event(下一个 user turn 后)

如果用户继续聊天,CC 在下一轮 user turn 后会发送**新 msgId** 的 assistant event。前一个 msgId 的所有事件视为已结束。

```ts
let lastMsgId: string | undefined;

function isAssistantBlockEvent(e: CCEvent): e is
  | Extract<CCEvent, { type: "assistant_text" }>
  | Extract<CCEvent, { type: "assistant_thinking" }>
  | Extract<CCEvent, { type: "assistant_tool_use" }> {
  return (
    e.type === "assistant_text" ||
    e.type === "assistant_thinking" ||
    e.type === "assistant_tool_use"
  );
}

for (const event of parser.parseChunk(chunk)) {
  if (isAssistantBlockEvent(event)) {
    if (lastMsgId && event.msgId !== lastMsgId) {
      closeMessage(lastMsgId);  // 上一个 message 真的结束了
    }
    lastMsgId = event.msgId;
  }
}
```

### 为什么不能直接信 `isLast=true`

历史背景:M0 期间 D6 决策"扁平化事件流"的初版假设是"一个 wire event 包含 N 个 content blocks,最后一个 block 带 isLast + messageMeta"。实测 CC 2.1.119 是**每个 content block 一个独立 wire event**,导致每个 wire event 内 blocks.length 通常 = 1,**每个 domain 事件都是 `isLast=true` 且都带 messageMeta**。这使 `isLast` 退化为"per wire event last",不再具备"per message last"的判别力。

完整背景见 `open-trad/docs` repo `design/retrospective-m0.md` §三 D6 后续 + §四 勘误 3。

## 设计参考

- `open-trad/docs` repo `design/03-architecture.md` §4.2
- `design/retrospective-m0.md` §三 D6 后续 + §四 勘误 3 + §五 TD-D6
- 拍板:D1(wire/domain 两层类型)、D6(扁平化事件流)、D6 后续修订(per-wire-event 语义)
