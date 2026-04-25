// SessionService 主路径测试。fixture 用 in-memory sqlite。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbServices, type DbServices } from "../../src/main/services/db";

describe("SessionService", () => {
  let svc: DbServices;

  beforeEach(() => {
    svc = createDbServices({ dbPath: ":memory:" });
  });

  afterEach(() => {
    svc.close();
  });

  it("create + get：写读循环", () => {
    const created = svc.sessions.create({
      id: "sess-001",
      title: "测试会话",
      skillId: "trade-email-writer",
      status: "active",
    });
    expect(created.id).toBe("sess-001");
    expect(created.title).toBe("测试会话");
    expect(created.skillId).toBe("trade-email-writer");
    expect(created.status).toBe("active");
    expect(created.totalCostUsd).toBe(0);
    expect(created.messageCount).toBe(0);
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.createdAt).toBe(created.updatedAt);

    const got = svc.sessions.get("sess-001");
    expect(got).toEqual(created);
  });

  it("get：不存在的 id 返回 undefined", () => {
    expect(svc.sessions.get("does-not-exist")).toBeUndefined();
  });

  it("list 分页：limit / offset 正确按 updated_at DESC", async () => {
    // 写 10 条 sessions，updated_at 递增（通过 updateStatus 触发更新）
    for (let i = 0; i < 10; i++) {
      svc.sessions.create({
        id: `s${i}`,
        title: `Session ${i}`,
        status: "active",
      });
      await sleep(2); // 跨毫秒分隔，确保排序稳定
    }

    const page1 = svc.sessions.list({ limit: 5, offset: 0 });
    expect(page1).toHaveLength(5);
    // 最新的 5 条（s9, s8, s7, s6, s5）
    expect(page1.map((r) => r.id)).toEqual(["s9", "s8", "s7", "s6", "s5"]);

    const page2 = svc.sessions.list({ limit: 5, offset: 5 });
    expect(page2).toHaveLength(5);
    expect(page2.map((r) => r.id)).toEqual(["s4", "s3", "s2", "s1", "s0"]);
  });

  it("count：返回总数", () => {
    expect(svc.sessions.count()).toBe(0);
    svc.sessions.create({ id: "a", title: "A", status: "active" });
    svc.sessions.create({ id: "b", title: "B", status: "active" });
    expect(svc.sessions.count()).toBe(2);
  });

  it("updateStatus：updated_at 同时刷新", async () => {
    const created = svc.sessions.create({ id: "x", title: "X", status: "active" });
    await sleep(2);
    svc.sessions.updateStatus("x", "completed");
    const updated = svc.sessions.get("x");
    expect(updated?.status).toBe("completed");
    expect(updated?.updatedAt).toBeGreaterThan(created.updatedAt);
  });

  it("updateMeta：写入 cost / messageCount / lastModel", () => {
    svc.sessions.create({ id: "y", title: "Y", status: "active" });
    svc.sessions.updateMeta("y", {
      lastModel: "claude-opus-4-7",
      totalCostUsd: 0.0095,
      messageCount: 3,
    });
    const got = svc.sessions.get("y");
    expect(got?.lastModel).toBe("claude-opus-4-7");
    expect(got?.totalCostUsd).toBeCloseTo(0.0095);
    expect(got?.messageCount).toBe(3);
  });

  it("delete：cascade 清理 events", () => {
    svc.sessions.create({ id: "with-events", title: "WE", status: "active" });
    svc.events.append({ sessionId: "with-events", seq: 0, type: "system", payload: {} });
    svc.events.append({
      sessionId: "with-events",
      seq: 1,
      type: "assistant_text",
      payload: { text: "hi" },
    });
    expect(svc.events.countBySession("with-events")).toBe(2);

    svc.sessions.delete("with-events");

    expect(svc.sessions.get("with-events")).toBeUndefined();
    expect(svc.events.countBySession("with-events")).toBe(0); // ON DELETE CASCADE
  });

  it("CHECK 约束：非法 status 抛 SqliteError", () => {
    expect(() =>
      svc.sessions.create({
        id: "bad",
        title: "Bad",
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid enum at runtime
        status: "not_a_status" as any,
      }),
    ).toThrow();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
