// 端到端集成测试：喂入真实 CC 2.1.119 生成的 NDJSON fixture，验证 parser 输出符合预期。
// fixture 生成命令见 PR 描述 / fixtures/README。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CCEvent } from "@opentrad/shared";
import { describe, expect, it } from "vitest";
import { StreamParser } from "../src";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "cc-2.1.119-simple.ndjson");

function parseFile(path: string): CCEvent[] {
  const raw = readFileSync(path, "utf8");
  const parser = new StreamParser();
  const events: CCEvent[] = [];
  for (const e of parser.parseChunk(raw)) events.push(e);
  for (const e of parser.flush()) events.push(e);
  return events;
}

describe("Integration: real CC 2.1.119 stream-json fixture", () => {
  const events = parseFile(fixturePath);

  it("produces the expected sequence of domain event types", () => {
    // Fixture contains: system/init, rate_limit_event, assistant(thinking),
    // assistant(text), result. With D6=X flatten, both assistant wire events
    // each produce 1 domain event (single content block each).
    expect(events.map((e) => e.type)).toEqual([
      "system",
      "rate_limit_event",
      "assistant_thinking",
      "assistant_text",
      "result",
    ]);
  });

  it("system/init data carries baseline CC version and apiKeySource", () => {
    const sys = events[0];
    if (sys?.type !== "system") throw new Error("expected system event");
    expect(sys.data.claudeCodeVersion).toBe("2.1.119");
    expect(sys.data.apiKeySource).toBe("none");
    expect(sys.data.cwd).toMatch(/opentrad/);
    expect(sys.data.mcpServers.length).toBeGreaterThan(0);
  });

  it("assistant_thinking preserves signature and marks isLast=true (single-block message)", () => {
    const think = events[2];
    if (think?.type !== "assistant_thinking") {
      throw new Error("expected assistant_thinking");
    }
    expect(think.signature.length).toBeGreaterThan(0);
    expect(think.thinking).toContain("OK");
    // single-block assistant wire event: this block is last
    expect(think.isLast).toBe(true);
    expect(think.messageMeta?.model).toBe("claude-haiku-4-5-20251001");
  });

  it("assistant_text carries msgId, seq, and messageMeta with token usage", () => {
    const text = events[3];
    if (text?.type !== "assistant_text") {
      throw new Error("expected assistant_text");
    }
    expect(text.text).toBe("好的。");
    expect(text.msgId).toMatch(/^msg_/);
    expect(text.seq).toBe(0);
    expect(text.isLast).toBe(true);
    expect(text.messageMeta?.usage.inputTokens).toBeGreaterThan(0);
    expect(text.messageMeta?.usage.outputTokens).toBeGreaterThan(0);
  });

  it("result event maps snake_case fields to camelCase domain data", () => {
    const r = events[4];
    if (r?.type !== "result") throw new Error("expected result");
    expect(r.subtype).toBe("success");
    expect(r.data.durationMs).toBeGreaterThan(0);
    expect(r.data.numTurns).toBe(1);
    expect(r.data.totalCostUsd).toBeGreaterThan(0);
    expect(r.data.isError).toBe(false);
    expect(r.data.terminalReason).toBe("completed");
  });

  it("rate_limit_event preserves five_hour policy metadata", () => {
    const rl = events[1];
    if (rl?.type !== "rate_limit_event") {
      throw new Error("expected rate_limit_event");
    }
    expect(rl.rateLimitInfo.rateLimitType).toBe("five_hour");
    expect(rl.rateLimitInfo.isUsingOverage).toBe(false);
  });

  it("all events carry consistent sessionId across the task", () => {
    const sessionIds = events
      .map((e): string | undefined => {
        if (e.type === "system") return e.data.sessionId;
        if (e.type === "result") return e.sessionId;
        if ("sessionId" in e) return e.sessionId;
        return undefined;
      })
      .filter((s): s is string => typeof s === "string");
    expect(sessionIds.length).toBe(events.length);
    expect(new Set(sessionIds).size).toBe(1); // all same
  });
});
