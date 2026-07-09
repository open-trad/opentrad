// ConnectorService：bb-browser 选品连接器的 desktop 主进程封装（M0.5）。
//
// 职责：
// - 预检（CLI / 浏览器 / daemon 三态）——委托 @opentrad/connectors 的 checkPreflight
// - 启用站点持久化（SQLite settings 表，key = connector.enabledSites）
// - 一键动作：启动 daemon / 打开站点登录页
//
// 所有方法永不抛异常裸露给 renderer——错误转 {ok,error,hint} 结构（发起人反馈：不要裸报错）。

import {
  openSiteLogin as bbOpenSiteLogin,
  startDaemon as bbStartDaemon,
  checkPreflight,
  getBbSite,
} from "@opentrad/connectors";
import type { ConnectorActionResult, ConnectorStatusResponse } from "@opentrad/shared";
import type { SettingsService } from "./db";

const ENABLED_SITES_KEY = "connector.enabledSites";

export class ConnectorService {
  constructor(private readonly settings: SettingsService) {}

  // 读已启用站点（脏数据保护：非数组返回空）
  getEnabledSites(): string[] {
    const raw = this.settings.get(ENABLED_SITES_KEY);
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  }

  setEnabled(siteId: string, enabled: boolean): string[] {
    // 未知站点忽略
    if (!getBbSite(siteId)) return this.getEnabledSites();
    const current = new Set(this.getEnabledSites());
    if (enabled) current.add(siteId);
    else current.delete(siteId);
    const next = [...current];
    this.settings.set(ENABLED_SITES_KEY, next);
    return next;
  }

  async status(): Promise<ConnectorStatusResponse> {
    const pre = await checkPreflight();
    return {
      cliInstalled: pre.cliInstalled,
      cliVersion: pre.cliVersion,
      browserFound: pre.browserFound,
      daemonRunning: pre.daemonRunning,
      cdpConnected: pre.cdpConnected,
      ready: pre.ready,
      nextAction: pre.nextAction,
      enabledSites: this.getEnabledSites(),
    };
  }

  async startDaemon(): Promise<ConnectorActionResult> {
    try {
      const pre = await bbStartDaemon();
      if (pre.ready) return { ok: true };
      if (!pre.browserFound) {
        return {
          ok: false,
          error: "未找到 Chromium 系浏览器",
          hint: "请安装 Chrome / Edge / Brave 后重试",
        };
      }
      return {
        ok: false,
        error: "浏览器服务未能就绪",
        hint: "端口可能被占用。可关闭已有的调试用 Chrome 后重试，或重启应用",
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async openLogin(siteId: string): Promise<ConnectorActionResult> {
    const site = getBbSite(siteId);
    if (!site) return { ok: false, error: `未知站点：${siteId}` };
    if (!site.loginUrl) return { ok: true }; // 无需登录
    try {
      await bbOpenSiteLogin(site.loginUrl);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
