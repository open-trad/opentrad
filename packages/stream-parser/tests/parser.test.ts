// StreamParser 行为测试：buffer / 跨 chunk 拼接 / JSON 失败 / schema 失败 / 未知 type fallback。

import type { CCEvent } from "@opentrad/shared";
import { describe, expect, it, vi } from "vitest";
import { StreamParser } from "../src";

function parseAll(chunks: string[], finalize = true): CCEvent[] {
  const parser = new StreamParser();
  const out: CCEvent[] = [];
  for (const chunk of chunks) {
    for (const evt of parser.parseChunk(chunk)) out.push(evt);
  }
  if (finalize) {
    for (const evt of parser.flush()) out.push(evt);
  }
  return out;
}

const SAMPLE_SYSTEM_INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  cwd: "/tmp",
  session_id: "s",
  tools: [],
  mcp_servers: [],
  model: "x",
  permissionMode: "default",
  apiKeySource: "subscription",
  claude_code_version: "2.1.119",
  uuid: "u",
});

describe("StreamParser line buffering", () => {
  it("yields no events when chunk has no newline (buffered)", () => {
    const parser = new StreamParser();
    const events = [...parser.parseChunk(SAMPLE_SYSTEM_INIT)];
    expect(events).toHaveLength(0);
  });

  it("yields the buffered event when newline arrives", () => {
    const parser = new StreamParser();
    const part1 = [...parser.parseChunk(SAMPLE_SYSTEM_INIT)];
    expect(part1).toHaveLength(0);
    const part2 = [...parser.parseChunk("\n")];
    expect(part2).toHaveLength(1);
    expect(part2[0]?.type).toBe("system");
  });

  it("handles events split across multiple chunks mid-line", () => {
    const half1 = SAMPLE_SYSTEM_INIT.slice(0, 40);
    const half2 = SAMPLE_SYSTEM_INIT.slice(40);
    const events = parseAll([half1, `${half2}\n`]);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("system");
  });

  it("processes multiple events in a single chunk", () => {
    const chunk = `${SAMPLE_SYSTEM_INIT}\n${SAMPLE_SYSTEM_INIT}\n`;
    const events = parseAll([chunk]);
    expect(events).toHaveLength(2);
  });

  it("ignores empty lines", () => {
    const events = parseAll([`${SAMPLE_SYSTEM_INIT}\n\n\n`]);
    expect(events).toHaveLength(1);
  });

  it("flush() emits the last line even if not terminated by newline", () => {
    const events = parseAll([SAMPLE_SYSTEM_INIT], true);
    expect(events).toHaveLength(1);
  });
});

describe("StreamParser error fallback", () => {
  it("emits unknown event and calls onJsonParseError for non-JSON line", () => {
    const onJsonParseError = vi.fn();
    const parser = new StreamParser({ onJsonParseError });
    const events = [...parser.parseChunk("not valid json\n")];
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("unknown");
    expect(onJsonParseError).toHaveBeenCalledOnce();
  });

  it("emits unknown event and calls onWireMismatch for wire-schema-invalid JSON", () => {
    const onWireMismatch = vi.fn();
    const parser = new StreamParser({ onWireMismatch });
    const events = [...parser.parseChunk('{"type":"future_event","payload":{}}\n')];
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("unknown");
    expect(onWireMismatch).toHaveBeenCalledOnce();
  });

  it("never throws on a badly-formed stream", () => {
    expect(() =>
      parseAll(["not json at all\n", '{"incomplete":\n', `${SAMPLE_SYSTEM_INIT}\n`]),
    ).not.toThrow();
  });

  it("preserves good events amid bad ones", () => {
    const events = parseAll(["garbage1\n", `${SAMPLE_SYSTEM_INIT}\n`, '{"type":"what_is_this"}\n']);
    expect(events.map((e) => e.type)).toEqual(["unknown", "system", "unknown"]);
  });
});
