// RiskRuleService 主路径测试。
// 重点：findMatching 用 IS（而非 =）匹配 nullable 字段；UNIQUE 索引基于 COALESCE 三键组合。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbServices, type DbServices } from "../../src/main/services/db";

describe("RiskRuleService", () => {
  let svc: DbServices;

  beforeEach(() => {
    svc = createDbServices({ dbPath: ":memory:" });
  });

  afterEach(() => {
    svc.close();
  });

  it("save + findMatching：带 skillId / toolName 的具体规则", () => {
    const saved = svc.riskRules.save({
      skillId: "trade-email-writer",
      toolName: "browser_open",
      decision: "allow",
    });
    expect(saved.skillId).toBe("trade-email-writer");
    expect(saved.toolName).toBe("browser_open");
    expect(saved.decision).toBe("allow");

    const found = svc.riskRules.findMatching({
      skillId: "trade-email-writer",
      toolName: "browser_open",
    });
    expect(found).toEqual(saved);
  });

  it("findMatching：null 字段精确匹配（用 IS NULL 而非 = NULL）", () => {
    svc.riskRules.save({
      skillId: null, // 适用所有 skill
      toolName: "browser_open",
      decision: "deny",
    });
    const found = svc.riskRules.findMatching({
      skillId: null,
      toolName: "browser_open",
    });
    expect(found).toBeDefined();
    expect(found?.decision).toBe("deny");

    // skillId 给具体值时不应匹配上面那条 null 规则
    expect(
      svc.riskRules.findMatching({
        skillId: "trade-email-writer",
        toolName: "browser_open",
      }),
    ).toBeUndefined();
  });

  it("UNIQUE 索引：相同 (skillId, toolName, businessAction) 第二次 save 走 ON CONFLICT 更新", () => {
    svc.riskRules.save({
      skillId: "x",
      toolName: "y",
      decision: "allow",
    });
    svc.riskRules.save({
      skillId: "x",
      toolName: "y",
      decision: "deny",
    });
    const found = svc.riskRules.findMatching({ skillId: "x", toolName: "y" });
    expect(found?.decision).toBe("deny");
    expect(svc.riskRules.list()).toHaveLength(1);
  });

  it("list：按 created_at DESC", async () => {
    svc.riskRules.save({ skillId: "a", toolName: null, decision: "allow" });
    await sleep(2);
    svc.riskRules.save({ skillId: "b", toolName: null, decision: "deny" });
    const list = svc.riskRules.list();
    expect(list.map((r) => r.skillId)).toEqual(["b", "a"]);
  });

  it("delete：按 id", () => {
    const saved = svc.riskRules.save({ skillId: "x", toolName: null, decision: "allow" });
    svc.riskRules.delete(saved.id);
    expect(svc.riskRules.list()).toHaveLength(0);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
