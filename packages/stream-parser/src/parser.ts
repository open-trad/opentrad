// CC stream-json NDJSON 流解析器。
// 职责：
// 1. 接收 string chunk（CC 子进程 stdout），按行切分做 buffer（最后一行可能不完整）
// 2. 每行 JSON.parse
// 3. 用 wire schema safeParse 校验 + 吸收字段差异（passthrough）
// 4. 调用 normalize 扁平化为 domain CCEvent yield 给消费方
// 5. 任何失败（非 JSON 行、wire schema 不匹配、未知 type）→ unknown domain 事件兜底，不丢数据

import type { CCEvent } from "@opentrad/shared";
import { WireCCEventSchema } from "@opentrad/shared";
import { normalizeWireEvent } from "./normalize";

export interface StreamParseOptions {
  // wire schema 不匹配时的回调（可用于上报/告警）。unknown 事件仍会 yield。
  onWireMismatch?: (raw: unknown, issues: unknown) => void;
  // JSON.parse 失败时的回调。unknown 事件仍会 yield。
  onJsonParseError?: (line: string, err: unknown) => void;
}

export class StreamParser {
  private buffer = "";

  constructor(private readonly opts: StreamParseOptions = {}) {}

  // 喂入一段 chunk，yield 出其中能完整解析的行对应的 CCEvent。
  // 不完整的尾行留在 buffer 里等下一次 chunk 或 flush()。
  *parseChunk(chunk: string): Generator<CCEvent> {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      yield* this.parseLine(trimmed);
    }
  }

  // 流结束时调用，处理 buffer 里的最后一行（如果 CC 不以 \n 结尾）。
  *flush(): Generator<CCEvent> {
    const trimmed = this.buffer.trim();
    this.buffer = "";
    if (trimmed) yield* this.parseLine(trimmed);
  }

  private *parseLine(line: string): Generator<CCEvent> {
    let rawJson: unknown;
    try {
      rawJson = JSON.parse(line);
    } catch (err) {
      this.opts.onJsonParseError?.(line, err);
      yield { type: "unknown", raw: line };
      return;
    }

    const result = WireCCEventSchema.safeParse(rawJson);
    if (!result.success) {
      this.opts.onWireMismatch?.(rawJson, result.error.issues);
      yield { type: "unknown", raw: rawJson };
      return;
    }

    yield* normalizeWireEvent(result.data);
  }
}
