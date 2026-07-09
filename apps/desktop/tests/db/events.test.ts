// EventService 主路径测试 + cascade 删除验证。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbServices, type DbServices } from "../../src/main/services/db";

describe("EventService", () => {
  let svc: DbServices;

  beforeEach(() => {
    svc = createDbServices({ dbPath: ":memory:" });
    svc.sessions.create({ id: "s1", title: "S1", status: "active" });
  });

  afterEach(() => {
    svc.close();
  });

  it("append + readBySession：按 seq ASC", () => {
    svc.events.append({ sessionId: "s1", seq: 0, type: "system", payload: { v: 1 } });
    svc.events.append({ sessionId: "s1", seq: 1, type: "assistant_text", payload: { text: "hi" } });
    svc.events.append({ sessionId: "s1", seq: 2, type: "result", payload: { cost: 0.001 } });

    const rows = svc.events.readBySession("s1");
    expect(rows).toHaveLength(3);
    expect(rows.map((e) => e.type)).toEqual(["system", "assistant_text", "result"]);
    expect(rows.map((e) => e.seq)).toEqual([0, 1, 2]);
    // payload 是 JSON string，调用方自行 parse
    expect(JSON.parse(rows[1]?.payload)).toEqual({ text: "hi" });
  });

  it("payload 接受 string 也接受任意 unknown（service 自己 stringify）", () => {
    svc.events.append({ sessionId: "s1", seq: 0, type: "raw", payload: '{"already":"string"}' });
    svc.events.append({ sessionId: "s1", seq: 1, type: "obj", payload: { foo: "bar" } });

    const rows = svc.events.readBySession("s1");
    expect(JSON.parse(rows[0]?.payload)).toEqual({ already: "string" });
    expect(JSON.parse(rows[1]?.payload)).toEqual({ foo: "bar" });
  });

  it("countBySession：精确计数", () => {
    expect(svc.events.countBySession("s1")).toBe(0);
    svc.events.append({ sessionId: "s1", seq: 0, type: "x", payload: {} });
    svc.events.append({ sessionId: "s1", seq: 1, type: "x", payload: {} });
    expect(svc.events.countBySession("s1")).toBe(2);
  });

  it("外键：写不存在的 session_id 抛错", () => {
    expect(() =>
      svc.events.append({ sessionId: "ghost", seq: 0, type: "x", payload: {} }),
    ).toThrow();
  });
});
