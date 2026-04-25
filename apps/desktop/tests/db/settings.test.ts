// SettingsService 主路径测试。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDbServices, type DbServices } from "../../src/main/services/db";

describe("SettingsService", () => {
  let svc: DbServices;

  beforeEach(() => {
    svc = createDbServices({ dbPath: ":memory:" });
  });

  afterEach(() => {
    svc.close();
  });

  it("初始化时已写入 schema_version=1", () => {
    expect(svc.settings.get("schema_version")).toBe(1);
  });

  it("set + get：写读循环（任意 JSON 值）", () => {
    svc.settings.set("language", "zh-CN");
    expect(svc.settings.get("language")).toBe("zh-CN");

    svc.settings.set("layout", { sidebar: 240, rightPanel: 300 });
    expect(svc.settings.get("layout")).toEqual({ sidebar: 240, rightPanel: 300 });

    svc.settings.set("flags", [1, 2, 3]);
    expect(svc.settings.get("flags")).toEqual([1, 2, 3]);
  });

  it("get：不存在的 key 返回 undefined", () => {
    expect(svc.settings.get("nope")).toBeUndefined();
  });

  it("set：upsert 语义（同 key 第二次覆盖）", () => {
    svc.settings.set("language", "zh-CN");
    svc.settings.set("language", "en");
    expect(svc.settings.get("language")).toBe("en");
  });

  it("delete：移除后再读 undefined", () => {
    svc.settings.set("temp", "value");
    expect(svc.settings.get("temp")).toBe("value");
    svc.settings.delete("temp");
    expect(svc.settings.get("temp")).toBeUndefined();
  });

  it("脏数据保护：value 列若被外部修改成非 JSON，get 返回 undefined 不抛", () => {
    // 直接绕过 service 写非 JSON 字符串
    svc.db
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run("corrupted", "not-json{", Date.now());
    expect(svc.settings.get("corrupted")).toBeUndefined();
  });
});
