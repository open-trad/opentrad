// InstalledSkillService 主路径测试。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbServices, type DbServices } from "../../src/main/services/db";

describe("InstalledSkillService", () => {
  let svc: DbServices;

  beforeEach(() => {
    svc = createDbServices({ dbPath: ":memory:" });
  });

  afterEach(() => {
    svc.close();
  });

  it("install + get：写读循环 + boolean 转换", () => {
    const row = svc.installedSkills.install({
      id: "trade-email-writer",
      source: "builtin",
      version: "1.0.0",
      installPath: "/path/to/skill",
      enabled: true,
    });
    expect(row.id).toBe("trade-email-writer");
    expect(row.source).toBe("builtin");
    expect(row.version).toBe("1.0.0");
    expect(row.installPath).toBe("/path/to/skill");
    expect(row.enabled).toBe(true);
    expect(row.installedAt).toBeGreaterThan(0);

    expect(svc.installedSkills.get("trade-email-writer")).toEqual(row);
  });

  it("list：按 installed_at DESC", async () => {
    svc.installedSkills.install({
      id: "first",
      source: "builtin",
      version: "1.0.0",
      installPath: "/a",
      enabled: true,
    });
    await sleep(2);
    svc.installedSkills.install({
      id: "second",
      source: "builtin",
      version: "1.0.0",
      installPath: "/b",
      enabled: true,
    });
    const list = svc.installedSkills.list();
    expect(list.map((s) => s.id)).toEqual(["second", "first"]);
  });

  it("install upsert：相同 id 第二次更新", () => {
    svc.installedSkills.install({
      id: "x",
      source: "builtin",
      version: "1.0.0",
      installPath: "/old",
      enabled: true,
    });
    svc.installedSkills.install({
      id: "x",
      source: "user_import",
      version: "1.1.0",
      installPath: "/new",
      enabled: false,
    });
    const got = svc.installedSkills.get("x");
    expect(got?.version).toBe("1.1.0");
    expect(got?.source).toBe("user_import");
    expect(got?.installPath).toBe("/new");
    expect(got?.enabled).toBe(false);
  });

  it("enable / disable：切换 boolean", () => {
    svc.installedSkills.install({
      id: "x",
      source: "builtin",
      version: "1.0.0",
      installPath: "/p",
      enabled: true,
    });
    svc.installedSkills.disable("x");
    expect(svc.installedSkills.get("x")?.enabled).toBe(false);
    svc.installedSkills.enable("x");
    expect(svc.installedSkills.get("x")?.enabled).toBe(true);
  });

  it("CHECK 约束：非法 source 抛 SqliteError", () => {
    expect(() =>
      svc.installedSkills.install({
        id: "bad",
        // biome-ignore lint/suspicious/noExplicitAny: testing invalid enum at runtime
        source: "from-mars" as any,
        version: "1.0.0",
        installPath: "/x",
        enabled: true,
      }),
    ).toThrow();
  });

  it("delete：移除后再读 undefined", () => {
    svc.installedSkills.install({
      id: "x",
      source: "builtin",
      version: "1.0.0",
      installPath: "/p",
      enabled: true,
    });
    svc.installedSkills.delete("x");
    expect(svc.installedSkills.get("x")).toBeUndefined();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
