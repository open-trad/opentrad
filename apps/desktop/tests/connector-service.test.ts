// ConnectorService 测试：用内存 SettingsService 假体，不触真实 bb-browser/preflight。
// preflight（checkPreflight/startDaemon/openLogin）走真实 spawn，但本测试只覆盖
// 启用站点持久化与未知站点保护——这些不 spawn。status/startDaemon 的集成留手测。

import { describe, expect, it } from "vitest";
import { ConnectorService } from "../src/main/services/connector-service";
import type { SettingsService } from "../src/main/services/db";

// 内存 settings 假体（只实现 ConnectorService 用到的 get/set）
function fakeSettings(): SettingsService {
  const store = new Map<string, unknown>();
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
  } as unknown as SettingsService;
}

describe("ConnectorService 启用站点持久化", () => {
  it("默认无启用站点", () => {
    const svc = new ConnectorService(fakeSettings());
    expect(svc.getEnabledSites()).toEqual([]);
  });

  it("启用/停用已知站点并持久化", () => {
    const settings = fakeSettings();
    const svc = new ConnectorService(settings);
    expect(svc.setEnabled("taobao", true)).toEqual(["taobao"]);
    expect(svc.setEnabled("1688", true).sort()).toEqual(["1688", "taobao"]);
    expect(svc.setEnabled("taobao", false)).toEqual(["1688"]);
    // 新实例从同一 settings 读回
    const svc2 = new ConnectorService(settings);
    expect(svc2.getEnabledSites()).toEqual(["1688"]);
  });

  it("未知站点忽略（不写入）", () => {
    const svc = new ConnectorService(fakeSettings());
    expect(svc.setEnabled("nope", true)).toEqual([]);
  });

  it("脏数据保护：settings 里非数组时返回空", () => {
    const settings = fakeSettings();
    settings.set("connector.enabledSites", "garbage");
    const svc = new ConnectorService(settings);
    expect(svc.getEnabledSites()).toEqual([]);
  });

  it("openLogin 未知站点返回错误结果不抛", async () => {
    const svc = new ConnectorService(fakeSettings());
    const r = await svc.openLogin("nope");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("未知站点");
  });

  it("openLogin 无需登录的站点直接 ok", async () => {
    const svc = new ConnectorService(fakeSettings());
    // google 无 loginUrl → 直接返回 ok，不 spawn
    const r = await svc.openLogin("google");
    expect(r.ok).toBe(true);
  });
});
