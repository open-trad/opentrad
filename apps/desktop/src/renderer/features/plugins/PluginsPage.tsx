// PluginsPage（M0.5）：图形化选品连接器页（发起人反馈：不要让用户填命令，要像 Accio 插件市场）。
//
// - 顶部预检状态条：bb-browser CLI / 浏览器 / daemon 三态；未就绪给一键修复或安装指引
// - 网站连接卡片网格：每卡 = emoji + 名称 + 描述 + 状态 chip + 启用开关 + 打开登录
// - 所有动作走 window.api.connector.*，错误以友好提示呈现，绝不裸报错
//
// 站点目录来自后端（BB_SITES）；这里通过 connector.status 拿启用态，用一份前端镜像渲染卡片元信息。

import type { ConnectorStatusResponse } from "@opentrad/shared";
import { BB_SITES } from "@opentrad/shared";
import { CheckCircle2, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

const GREEN = "#16a34a";

export function PluginsPage(): ReactElement {
  const [status, setStatus] = useState<ConnectorStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setStatus(await window.api.connector.status());
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enabled = new Set(status?.enabledSites ?? []);

  const toggle = async (siteId: string, next: boolean): Promise<void> => {
    try {
      const list = await window.api.connector.setEnabled(siteId, next);
      setStatus((s) => (s ? { ...s, enabledSites: list } : s));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  const startDaemon = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await window.api.connector.startDaemon();
      if (!r.ok) setNotice(`${r.error ?? "启动失败"}${r.hint ? `——${r.hint}` : ""}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const openLogin = async (siteId: string): Promise<void> => {
    try {
      const r = await window.api.connector.openLogin(siteId);
      if (!r.ok) setNotice(r.error ?? "打开登录页失败");
      else setNotice("已在浏览器打开登录页，登录后即可搜索该站点");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={{ padding: "1.5rem 2rem", overflowY: "auto", height: "100%" }}>
      <div
        style={{ display: "flex", alignItems: "baseline", gap: "0.75rem", marginBottom: "1rem" }}
      >
        <h2 style={{ fontSize: "1.35rem", margin: 0 }}>选品连接</h2>
        <span style={{ fontSize: "0.85rem", color: "#9ca3af" }}>
          用你自己浏览器的登录态搜各平台货源，数据不经第三方
        </span>
      </div>

      <StatusBar
        status={status}
        loading={loading}
        busy={busy}
        onStart={() => void startDaemon()}
        onRefresh={() => void refresh()}
      />

      {notice ? (
        <div
          style={{
            margin: "0.75rem 0",
            padding: "0.6rem 0.9rem",
            background: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: 8,
            fontSize: "0.85rem",
            color: "#92400e",
          }}
        >
          {notice}
        </div>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
          gap: "0.9rem",
          marginTop: "1rem",
        }}
      >
        {BB_SITES.map((site) => (
          <SiteCard
            key={site.id}
            emoji={site.emoji}
            name={site.name}
            description={site.description}
            requiresLogin={site.requiresLogin}
            enabled={enabled.has(site.id)}
            onToggle={(v) => void toggle(site.id, v)}
            onOpenLogin={() => void openLogin(site.id)}
          />
        ))}
      </div>
    </div>
  );
}

function StatusBar({
  status,
  loading,
  busy,
  onStart,
  onRefresh,
}: {
  status: ConnectorStatusResponse | null;
  loading: boolean;
  busy: boolean;
  onStart: () => void;
  onRefresh: () => void;
}): ReactElement {
  const items: { label: string; ok: boolean; hint?: string }[] = status
    ? [
        {
          label: `命令行 ${status.cliVersion ? `v${status.cliVersion}` : ""}`,
          ok: status.cliInstalled,
          hint: "npm install -g bb-browser",
        },
        { label: "浏览器", ok: status.browserFound, hint: "安装 Chrome / Edge / Brave" },
        { label: "浏览器服务", ok: status.daemonRunning && status.cdpConnected },
      ]
    : [];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "1.25rem",
        padding: "0.7rem 1rem",
        background: "#f8fafc",
        border: "1px solid #e5e7eb",
        borderRadius: 10,
      }}
    >
      {loading && !status ? (
        <span
          style={{
            color: "#9ca3af",
            fontSize: "0.85rem",
            display: "inline-flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          <Loader2 size={14} className="spin" /> 检测中…
        </span>
      ) : (
        items.map((it) => (
          <span
            key={it.label}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.85rem" }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: it.ok ? GREEN : "#f59e0b",
                display: "inline-block",
              }}
            />
            <span style={{ color: it.ok ? "#374151" : "#92400e" }}>{it.label}</span>
            {!it.ok && it.hint ? (
              <span style={{ color: "#9ca3af", fontSize: "0.75rem" }}>（{it.hint}）</span>
            ) : null}
          </span>
        ))
      )}

      <div style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
        {status && !status.ready && status.browserFound && status.cliInstalled ? (
          <button type="button" onClick={onStart} disabled={busy} style={primaryBtn(busy)}>
            {busy ? <Loader2 size={13} className="spin" /> : null} 启动浏览器服务
          </button>
        ) : null}
        {status?.ready ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              color: GREEN,
              fontSize: "0.85rem",
            }}
          >
            <CheckCircle2 size={14} /> 就绪
          </span>
        ) : null}
        <button type="button" onClick={onRefresh} title="刷新状态" style={ghostBtn}>
          <RefreshCw size={14} />
        </button>
      </div>
    </div>
  );
}

function SiteCard({
  emoji,
  name,
  description,
  requiresLogin,
  enabled,
  onToggle,
  onOpenLogin,
}: {
  emoji: string;
  name: string;
  description: string;
  requiresLogin: boolean;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  onOpenLogin: () => void;
}): ReactElement {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        padding: "0.9rem 1rem",
        background: "#fff",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
        <span style={{ fontSize: "1.5rem" }}>{emoji}</span>
        <span style={{ fontWeight: 600, fontSize: "0.95rem" }}>{name}</span>
        <label style={{ marginLeft: "auto", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
            style={{ accentColor: GREEN, width: 16, height: 16 }}
          />
        </label>
      </div>
      <div style={{ fontSize: "0.8rem", color: "#6b7280", minHeight: "2.4em", lineHeight: 1.4 }}>
        {description}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <span
          style={{
            fontSize: "0.72rem",
            padding: "0.1rem 0.5rem",
            borderRadius: 999,
            background: enabled ? "#dcfce7" : "#f3f4f6",
            color: enabled ? "#166534" : "#9ca3af",
          }}
        >
          {enabled ? "已启用" : "未启用"}
        </span>
        {requiresLogin ? (
          <button type="button" onClick={onOpenLogin} style={{ ...linkBtn, marginLeft: "auto" }}>
            <ExternalLink size={12} /> 打开登录
          </button>
        ) : (
          <span style={{ marginLeft: "auto", fontSize: "0.72rem", color: "#9ca3af" }}>
            无需登录
          </span>
        )}
      </div>
    </div>
  );
}

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "0.35rem 0.8rem",
    background: GREEN,
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: "0.82rem",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.7 : 1,
  };
}

const ghostBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0.35rem",
  background: "transparent",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  color: "#6b7280",
  cursor: "pointer",
};

const linkBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: "transparent",
  border: "none",
  color: "#2563eb",
  fontSize: "0.75rem",
  cursor: "pointer",
  padding: 0,
};
