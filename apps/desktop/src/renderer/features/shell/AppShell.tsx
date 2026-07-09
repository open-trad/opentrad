// AppShell（M0.5 界面改版）：对齐 Codex/Accio 桌面应用形态。
// 左侧固定侧栏（新任务/插件/设置）+ 右侧主区（首页 hero / 对话 / 插件页 / 设置）。
// 浅色主题、大圆角、OpenTrad 绿强调色。不引入路由库（沿 D9-1 无 router 决策），用 view 状态切换。

import type { ProviderProfile } from "@opentrad/model-providers";
import { BB_SITES } from "@opentrad/shared";
import { MessageSquarePlus, Plug, Settings as SettingsIcon } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { useAgentStore } from "../../stores/agent";
import { AgentChatPanel } from "../agent/AgentChatPanel";
import { PluginsPage } from "../plugins/PluginsPage";
import { ProvidersTab } from "../settings/ProvidersTab";

const GREEN = "#16a34a";

type View = "new" | "chat" | "plugins" | "settings";

const SCENE_CHIPS: { label: string; prompt: string }[] = [
  { label: "选品找货", prompt: "帮我在 1688 找「」的货源，给我价格带、MOQ 和供应商对比" },
  { label: "供应商背调", prompt: "帮我背调这家供应商：" },
  {
    label: "listing 上架",
    prompt: "把这个产品资料做成 Amazon 英文 listing（标题+五点+描述+关键词）：",
  },
  { label: "外贸邮件", prompt: "帮我写一封给客户的报价跟进邮件，语气专业友好：" },
];

export function AppShell(): ReactElement {
  const [view, setView] = useState<View>("new");
  const profiles = useAgentStore((s) => s.profiles);
  const profilesLoaded = useAgentStore((s) => s.profilesLoaded);
  const loadProfiles = useAgentStore((s) => s.loadProfiles);

  useEffect(() => {
    if (!profilesLoaded) void loadProfiles();
  }, [profilesLoaded, loadProfiles]);

  return (
    <div style={{ display: "flex", height: "100%", background: "#fff", color: "#1f2937" }}>
      <Sidebar view={view} onNavigate={setView} />
      <main style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {view === "new" ? (
          <HomeHero
            profiles={profiles}
            onStarted={() => setView("chat")}
            onGoPlugins={() => setView("plugins")}
          />
        ) : null}
        {view === "chat" ? <AgentChatPanel /> : null}
        {view === "plugins" ? <PluginsPage /> : null}
        {view === "settings" ? (
          <div style={{ padding: "1.5rem 2rem", overflowY: "auto" }}>
            <h2 style={{ fontSize: "1.35rem", marginTop: 0 }}>设置 · 模型</h2>
            <ProvidersTab />
          </div>
        ) : null}
      </main>
    </div>
  );
}

function Sidebar({
  view,
  onNavigate,
}: {
  view: View;
  onNavigate: (v: View) => void;
}): ReactElement {
  const navItems: { key: View; label: string; icon: ReactElement }[] = [
    { key: "new", label: "新任务", icon: <MessageSquarePlus size={17} /> },
    { key: "plugins", label: "插件", icon: <Plug size={17} /> },
    { key: "settings", label: "设置", icon: <SettingsIcon size={17} /> },
  ];
  return (
    <aside
      style={{
        width: 224,
        borderRight: "1px solid #eef0f2",
        background: "#fafafa",
        display: "flex",
        flexDirection: "column",
        padding: "1rem 0.75rem",
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.25rem 0.5rem 1rem" }}
      >
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: `linear-gradient(135deg, ${GREEN}, #059669)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#fff",
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          OT
        </div>
        <span style={{ fontWeight: 700, fontSize: "1.05rem" }}>OpenTrad</span>
      </div>

      <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {navItems.map((item) => {
          const active = view === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onNavigate(item.key)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "0.5rem 0.6rem",
                borderRadius: 8,
                border: "none",
                background: active ? "#eef2ff" : "transparent",
                color: active ? "#111827" : "#4b5563",
                fontSize: "0.9rem",
                cursor: "pointer",
                fontWeight: active ? 600 : 400,
                textAlign: "left",
              }}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </nav>

      <div
        style={{
          marginTop: "auto",
          padding: "0.5rem",
          borderTop: "1px solid #eef0f2",
          fontSize: "0.78rem",
          color: "#9ca3af",
        }}
      >
        本地优先 · 数据归你
      </div>
    </aside>
  );
}

function HomeHero({
  profiles,
  onStarted,
  onGoPlugins,
}: {
  profiles: ProviderProfile[];
  onStarted: () => void;
  onGoPlugins: () => void;
}): ReactElement {
  const startSession = useAgentStore((s) => s.startSession);
  const sendMessage = useAgentStore((s) => s.sendMessage);
  const [text, setText] = useState("");
  const [profileId, setProfileId] = useState("");
  const [enabledSites, setEnabledSites] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);

  const effectiveProfileId = profileId || profiles[0]?.id || "";

  useEffect(() => {
    // 拿已启用站点（会话启动时注册为工具）+ 未启用站点（做连接建议卡片）
    void window.api.connector
      .status()
      .then((s) => setEnabledSites(s.enabledSites))
      .catch(() => {});
  }, []);

  const submit = async (): Promise<void> => {
    if (!text.trim() || !effectiveProfileId) return;
    setStarting(true);
    try {
      await startSession({ profileId: effectiveProfileId, enabledSites });
      await sendMessage(text.trim());
      onStarted();
    } finally {
      setStarting(false);
    }
  };

  const suggestions = BB_SITES.filter((s) => !enabledSites.includes(s.id)).slice(0, 3);
  const noProfile = profiles.length === 0;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
        overflowY: "auto",
      }}
    >
      <div style={{ width: "min(720px, 100%)" }}>
        <h1
          style={{ fontSize: "2.1rem", textAlign: "center", margin: "0 0 1.5rem", fontWeight: 600 }}
        >
          我们该做什么？
        </h1>

        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 16,
            padding: "0.9rem 1rem",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
            }}
            placeholder="输入任务，或描述你要找的货…（⌘/Ctrl+Enter 发送）"
            rows={3}
            style={{
              width: "100%",
              border: "none",
              outline: "none",
              resize: "none",
              fontSize: "0.95rem",
              fontFamily: "inherit",
              background: "transparent",
              color: "#1f2937",
            }}
          />
          <div
            style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginTop: "0.5rem" }}
          >
            <button type="button" onClick={onGoPlugins} style={toolbarBtn}>
              <Plug size={14} /> 插件
            </button>
            <div
              style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.6rem" }}
            >
              {noProfile ? (
                <span style={{ fontSize: "0.8rem", color: "#f59e0b" }}>
                  先在「设置」接入一个模型
                </span>
              ) : (
                <select
                  value={effectiveProfileId}
                  onChange={(e) => setProfileId(e.target.value)}
                  style={{
                    fontSize: "0.82rem",
                    padding: "0.3rem 0.5rem",
                    borderRadius: 8,
                    border: "1px solid #e5e7eb",
                    background: "#fff",
                  }}
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={() => void submit()}
                disabled={starting || noProfile || !text.trim()}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: "50%",
                  border: "none",
                  background: starting || noProfile || !text.trim() ? "#d1d5db" : GREEN,
                  color: "#fff",
                  cursor: starting || noProfile || !text.trim() ? "default" : "pointer",
                  fontSize: 16,
                }}
                aria-label="发送"
              >
                ↑
              </button>
            </div>
          </div>
        </div>

        {/* 场景 chips */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.5rem",
            justifyContent: "center",
            marginTop: "1.1rem",
          }}
        >
          {SCENE_CHIPS.map((c) => (
            <button key={c.label} type="button" onClick={() => setText(c.prompt)} style={chipBtn}>
              {c.label}
            </button>
          ))}
        </div>

        {/* 连接建议 */}
        {suggestions.length > 0 ? (
          <div style={{ marginTop: "1.8rem" }}>
            <div
              style={{
                fontSize: "0.8rem",
                color: "#9ca3af",
                marginBottom: "0.6rem",
                textAlign: "center",
              }}
            >
              连接更多平台以搜货比价
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.7rem" }}>
              {suggestions.map((s) => (
                <button key={s.id} type="button" onClick={onGoPlugins} style={connectCard}>
                  <span style={{ fontSize: "1.4rem" }}>{s.emoji}</span>
                  <span style={{ fontWeight: 600, fontSize: "0.85rem" }}>{s.name}</span>
                  <span
                    style={{
                      fontSize: "0.72rem",
                      color: "#9ca3af",
                      textAlign: "center",
                      lineHeight: 1.3,
                    }}
                  >
                    点击去启用
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const toolbarBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "0.3rem 0.6rem",
  background: "#f3f4f6",
  border: "none",
  borderRadius: 8,
  fontSize: "0.8rem",
  color: "#4b5563",
  cursor: "pointer",
};

const chipBtn: React.CSSProperties = {
  padding: "0.4rem 0.85rem",
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 999,
  fontSize: "0.82rem",
  color: "#4b5563",
  cursor: "pointer",
};

const connectCard: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  padding: "0.9rem 0.5rem",
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  cursor: "pointer",
};
