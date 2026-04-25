// AuditLogService 主路径测试。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbServices, type DbServices } from "../../src/main/services/db";

describe("AuditLogService", () => {
  let svc: DbServices;

  beforeEach(() => {
    svc = createDbServices({ dbPath: ":memory:" });
  });

  afterEach(() => {
    svc.close();
  });

  it("append + queryBySession：boolean automated 转换", () => {
    svc.auditLog.append({
      sessionId: "s1",
      toolName: "browser_open",
      decision: "allow",
      automated: false,
      reason: "user clicked allow_once",
    });
    svc.auditLog.append({
      sessionId: "s1",
      toolName: "draft_save",
      decision: "allow",
      automated: true,
      reason: "safe tool",
    });

    const rows = svc.auditLog.queryBySession("s1");
    expect(rows).toHaveLength(2);
    // 按 timestamp DESC（后写的在前）
    expect(rows[0]?.toolName).toBe("draft_save");
    expect(rows[0]?.automated).toBe(true);
    expect(rows[1]?.toolName).toBe("browser_open");
    expect(rows[1]?.automated).toBe(false);
  });

  it("queryByDateRange：[from, to) 半开区间", () => {
    const T0 = 1_700_000_000_000;
    svc.auditLog.append({
      sessionId: "s1",
      toolName: "a",
      decision: "allow",
      automated: true,
      timestamp: T0 + 100,
    });
    svc.auditLog.append({
      sessionId: "s1",
      toolName: "b",
      decision: "allow",
      automated: true,
      timestamp: T0 + 200,
    });
    svc.auditLog.append({
      sessionId: "s1",
      toolName: "c",
      decision: "allow",
      automated: true,
      timestamp: T0 + 300,
    });

    // [T0+100, T0+300)：含 100 / 200，不含 300
    const result = svc.auditLog.queryByDateRange(T0 + 100, T0 + 300);
    expect(result.map((r) => r.toolName)).toEqual(["b", "a"]);
  });

  it("分页 limit / offset", () => {
    for (let i = 0; i < 10; i++) {
      svc.auditLog.append({
        sessionId: "s1",
        toolName: `t${i}`,
        decision: "allow",
        automated: true,
        timestamp: 1000 + i,
      });
    }
    const page1 = svc.auditLog.queryBySession("s1", { limit: 3, offset: 0 });
    expect(page1.map((r) => r.toolName)).toEqual(["t9", "t8", "t7"]);
    const page2 = svc.auditLog.queryBySession("s1", { limit: 3, offset: 3 });
    expect(page2.map((r) => r.toolName)).toEqual(["t6", "t5", "t4"]);
  });
});
