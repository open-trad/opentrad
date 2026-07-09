// AppShell（M0.5 界面 polish）：对齐 Accio Work / Codex 桌面 AI workbench 质感。
// - 无独立顶部 title bar，macOS 红绿灯融入侧栏顶部（main 设 titleBarStyle: hiddenInset）
// - 侧栏：logo / 主导航 / 任务历史 / 团队 Beta / 用户区
// - 首页：Agent Header + Composer + 场景 chips + 插件建议卡片
// 保留全部现有逻辑：startSession / sendMessage / profiles / enabledSites / BB_SITES / onGoPlugins。
//
// 设计 token（发起人指定）：绿 #16a34a / 文字 #111827 / 次级 #6b7280·#9ca3af /
// 侧栏 #f6f7f8 / 主背景 #fff / border #e5e7eb / active nav 浅绿 #ecfdf5。

import type { ProviderProfile } from "@opentrad/model-providers";
import { type AgentSessionMeta, BB_SITES } from "@opentrad/shared";
import {
  Boxes,
  Clock,
  FileText,
  Languages,
  Mail,
  MessageSquarePlus,
  Mic,
  Package,
  Plug,
  Plus,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Truck,
  Users,
} from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from "react";
import { useAgentStore } from "../../stores/agent";
import { AgentChatPanel } from "../agent/AgentChatPanel";
import { PluginsPage } from "../plugins/PluginsPage";
import { ProvidersTab } from "../settings/ProvidersTab";

const C = {
  green: "#16a34a",
  greenSoft: "#ecfdf5",
  text: "#111827",
  sub: "#6b7280",
  subDim: "#9ca3af",
  sidebar: "#f6f7f8",
  bg: "#ffffff",
  border: "#e5e7eb",
};

type View = "new" | "chat" | "plugins" | "settings";

const SCENE_CHIPS: { label: string; icon: ReactElement; prompt: string }[] = [
  {
    label: "选品找货",
    icon: <Search size={14} />,
    prompt: "帮我在 1688 找「」的货源，给我价格带、MOQ 和供应商对比",
  },
  { label: "供应商背调", icon: <ShieldCheck size={14} />, prompt: "帮我背调这家供应商：" },
  {
    label: "Listing 上架",
    icon: <Package size={14} />,
    prompt: "把这个产品资料做成 Amazon 英文 listing（标题+五点+描述+关键词）：",
  },
  {
    label: "外贸邮件",
    icon: <Mail size={14} />,
    prompt: "帮我写一封给客户的报价跟进邮件，语气专业友好：",
  },
  {
    label: "采购比价",
    icon: <Truck size={14} />,
    prompt: "帮我对比这几个货源的价格、MOQ 和交期：",
  },
];

export function AppShell(): ReactElement {
  const [view, setView] = useState<View>("new");
  const profilesLoaded = useAgentStore((s) => s.profilesLoaded);
  const loadProfiles = useAgentStore((s) => s.loadProfiles);
  const loadSessions = useAgentStore((s) => s.loadSessions);
  const resetSession = useAgentStore((s) => s.resetSession);

  useEffect(() => {
    if (!profilesLoaded) void loadProfiles();
    void loadSessions();
  }, [profilesLoaded, loadProfiles, loadSessions]);

  const goNew = (): void => {
    resetSession();
    setView("new");
  };

  return (
    <div style={{ display: "flex", height: "100%", background: C.bg, color: C.text }}>
      <Sidebar
        view={view}
        onNavigate={setView}
        onNewTask={goNew}
        onOpenSession={() => setView("chat")}
      />
      <main style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {view === "new" ? (
          <HomeHero onStarted={() => setView("chat")} onGoPlugins={() => setView("plugins")} />
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

// ---------------- Sidebar ----------------

function Sidebar({
  view,
  onNavigate,
  onNewTask,
  onOpenSession,
}: {
  view: View;
  onNavigate: (v: View) => void;
  onNewTask: () => void;
  onOpenSession: () => void;
}): ReactElement {
  const sessions = useAgentStore((s) => s.sessions);
  const currentSessionId = useAgentStore((s) => s.sessionId);
  const loadSession = useAgentStore((s) => s.loadSession);

  const navItems: { key: View; label: string; icon: ReactElement; onClick?: () => void }[] = [
    { key: "new", label: "新任务", icon: <MessageSquarePlus size={16} />, onClick: onNewTask },
    { key: "plugins", label: "插件", icon: <Plug size={16} /> },
    { key: "settings", label: "设置", icon: <SettingsIcon size={16} /> },
  ];
  // 静态占位导航（对齐 Accio 信息密度；后续里程碑接功能）
  const soonItems: { label: string; icon: ReactElement }[] = [
    { label: "智能体", icon: <Boxes size={16} /> },
    { label: "定时任务", icon: <Clock size={16} /> },
    { label: "消息渠道", icon: <Users size={16} /> },
  ];

  return (
    <aside
      style={{
        width: 240,
        borderRight: `1px solid ${C.border}`,
        background: C.sidebar,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* 顶部：留出 macOS 红绿灯空间 + 可拖拽 */}
      <div
        style={{
          padding: "34px 14px 10px",
          display: "flex",
          alignItems: "center",
          gap: 9,
          // @ts-expect-error webkit app region 用于窗口拖拽
          WebkitAppRegion: "drag",
        }}
      >
        <LogoMark />
        <span style={{ fontWeight: 700, fontSize: "1.05rem", letterSpacing: "-0.01em" }}>
          OpenTrad
        </span>
      </div>

      <div style={{ padding: "0 10px", display: "flex", flexDirection: "column", gap: 1 }}>
        {navItems.map((item) => (
          <NavButton
            key={item.key}
            active={view === item.key}
            icon={item.icon}
            label={item.label}
            onClick={item.onClick ?? (() => onNavigate(item.key))}
          />
        ))}
        {soonItems.map((item) => (
          <NavButton
            key={item.label}
            active={false}
            icon={item.icon}
            label={item.label}
            muted
            onClick={() => {}}
          />
        ))}
      </div>

      {/* 任务历史 */}
      <div style={{ marginTop: 14, padding: "0 10px", flex: 1, overflowY: "auto", minHeight: 0 }}>
        <div style={sectionLabel}>任务</div>
        {sessions.length === 0 ? (
          <div style={{ fontSize: "0.78rem", color: C.subDim, padding: "0.4rem 0.6rem" }}>
            暂无历史，从「新任务」开始
          </div>
        ) : (
          sessions.map((s) => (
            <SessionRow
              key={s.sessionId}
              session={s}
              active={s.sessionId === currentSessionId}
              onClick={async () => {
                await loadSession(s.sessionId);
                onOpenSession();
              }}
            />
          ))
        )}

        <div
          style={{ ...sectionLabel, marginTop: 16, display: "flex", alignItems: "center", gap: 6 }}
        >
          团队 <span style={teamBeta}>Beta</span>
        </div>
        <div style={{ fontSize: "0.78rem", color: C.subDim, padding: "0.4rem 0.6rem" }}>
          即将上线
        </div>
      </div>

      {/* 用户区 */}
      <div
        style={{
          borderTop: `1px solid ${C.border}`,
          padding: "10px 14px",
          display: "flex",
          alignItems: "center",
          gap: 9,
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: C.green,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          你
        </div>
        <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
          <span style={{ fontSize: "0.82rem", fontWeight: 500 }}>本地用户</span>
          <span style={{ fontSize: "0.7rem", color: C.subDim }}>本地优先 · 数据归你</span>
        </div>
      </div>
    </aside>
  );
}

function LogoMark(): ReactElement {
  return (
    <div
      style={{
        width: 27,
        height: 27,
        borderRadius: 8,
        background: `linear-gradient(135deg, ${C.green}, #0f766e)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#fff",
        fontWeight: 700,
        fontSize: 12,
        // @ts-expect-error 拖拽区内的 logo 保持可拖拽
        WebkitAppRegion: "drag",
      }}
    >
      OT
    </div>
  );
}

function NavButton({
  active,
  icon,
  label,
  muted,
  onClick,
}: {
  active: boolean;
  icon: ReactElement;
  label: string;
  muted?: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "0.5rem 0.6rem",
        borderRadius: 8,
        border: "none",
        background: active ? C.greenSoft : "transparent",
        color: active ? "#065f46" : muted ? C.subDim : "#374151",
        fontSize: "0.88rem",
        cursor: "pointer",
        fontWeight: active ? 600 : 400,
        textAlign: "left",
        width: "100%",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function SessionRow({
  session,
  active,
  onClick,
}: {
  session: AgentSessionMeta;
  active: boolean;
  onClick: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={session.title ?? "未命名会话"}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "0.4rem 0.6rem",
        borderRadius: 8,
        border: "none",
        background: active ? "#eef2f5" : "transparent",
        color: active ? C.text : "#4b5563",
        fontSize: "0.83rem",
        cursor: "pointer",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {session.title ?? "未命名会话"}
    </button>
  );
}

// ---------------- Home Hero ----------------

function HomeHero({
  onStarted,
  onGoPlugins,
}: {
  onStarted: () => void;
  onGoPlugins: () => void;
}): ReactElement {
  const profiles = useAgentStore((s) => s.profiles);
  const startSession = useAgentStore((s) => s.startSession);
  const sendMessage = useAgentStore((s) => s.sendMessage);
  const [text, setText] = useState("");
  const [profileId, setProfileId] = useState("");
  const [enabledSites, setEnabledSites] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);

  const effectiveProfileId = profileId || profiles[0]?.id || "";
  const noProfile = profiles.length === 0;

  useEffect(() => {
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

  const suggestions = useMemo(
    () =>
      BB_SITES.filter(
        (s) => ["1688", "taobao", "pdd"].includes(s.id) && !enabledSites.includes(s.id),
      ),
    [enabledSites],
  );

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
        // 顶部可拖拽区（与侧栏红绿灯行同高，保证整条顶栏可拖）
      }}
    >
      <div
        style={{
          width: "min(860px, 100%)",
          display: "flex",
          flexDirection: "column",
          gap: "1.1rem",
        }}
      >
        {/* Agent Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 11,
              background: `linear-gradient(135deg, ${C.green}, #0f766e)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontWeight: 700,
            }}
          >
            OT
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: "1.05rem" }}>OpenTrad Agent</div>
            <div
              style={{
                fontSize: "0.82rem",
                color: C.sub,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              选品、供应商背调、Listing 本地化、外贸邮件、平台运营的 AI 工作台
            </div>
          </div>
          <button type="button" style={switchPill} title="切换智能体（即将上线）">
            切换智能体
          </button>
        </div>

        {/* Composer */}
        <div
          style={{
            border: `1px solid ${C.border}`,
            borderRadius: 22,
            padding: "1rem 1.1rem",
            boxShadow: "0 2px 10px rgba(15,23,42,0.05)",
            background: "#fff",
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
            }}
            placeholder="描述你的外贸任务，或想找的货、想联系的供应商…（⌘/Ctrl+Enter 发送）"
            rows={3}
            style={{
              width: "100%",
              border: "none",
              outline: "none",
              resize: "none",
              fontSize: "0.98rem",
              lineHeight: 1.5,
              fontFamily: "inherit",
              background: "transparent",
              color: C.text,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
            <IconPill title="附件（即将上线）">
              <Plus size={15} />
            </IconPill>
            <IconPill onClick={onGoPlugins} title="插件">
              <Plug size={14} /> 插件
            </IconPill>
            <IconPill title="权限：完全访问（即将上线）">
              <ShieldCheck size={14} /> 完全访问
            </IconPill>
            <IconPill title="工作目录（即将上线）">
              <FileText size={14} /> 工作目录
            </IconPill>

            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              {noProfile ? (
                <span style={{ fontSize: "0.8rem", color: "#d97706" }}>先在「设置」接入模型</span>
              ) : (
                <ModelPill profiles={profiles} value={effectiveProfileId} onChange={setProfileId} />
              )}
              <IconPill title="自动（即将上线）">自动</IconPill>
              <IconPill title="语音（即将上线）">
                <Mic size={15} />
              </IconPill>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={starting || noProfile || !text.trim()}
                aria-label="发送"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  border: "none",
                  background: starting || noProfile || !text.trim() ? "#d1d5db" : C.green,
                  color: "#fff",
                  cursor: starting || noProfile || !text.trim() ? "default" : "pointer",
                  fontSize: 17,
                  flexShrink: 0,
                }}
              >
                ↑
              </button>
            </div>
          </div>
        </div>

        {/* 场景 chips */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
          {SCENE_CHIPS.map((c) => (
            <button key={c.label} type="button" onClick={() => setText(c.prompt)} style={sceneChip}>
              {c.icon}
              {c.label}
            </button>
          ))}
        </div>

        {/* 插件建议卡片 */}
        {suggestions.length > 0 ? (
          <div style={{ marginTop: 8 }}>
            <div
              style={{ fontSize: "0.8rem", color: C.subDim, marginBottom: 8, textAlign: "center" }}
            >
              连接平台以搜货比价
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${suggestions.length}, 1fr)`,
                gap: 10,
              }}
            >
              {suggestions.map((s) => (
                <button key={s.id} type="button" onClick={onGoPlugins} style={pluginCard}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={pluginIcon}>
                      <Package size={15} />
                    </span>
                    <span style={{ fontWeight: 600, fontSize: "0.88rem" }}>{s.name}</span>
                  </div>
                  <span style={{ fontSize: "0.75rem", color: C.sub, lineHeight: 1.4 }}>
                    {s.description}
                  </span>
                  <span style={pluginTag}>未启用 · 点击启用</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// 自定义模型选择 pill（不用原生 select 外观；用透明 select 叠在 pill 上保留可用性）
function ModelPill({
  profiles,
  value,
  onChange,
}: {
  profiles: ProviderProfile[];
  value: string;
  onChange: (id: string) => void;
}): ReactElement {
  const current = profiles.find((p) => p.id === value);
  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      <span style={{ ...pillBase, gap: 6, paddingRight: 22 }}>
        <Languages size={13} />
        <span
          style={{
            maxWidth: 200,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {current?.displayName ?? "选择模型"}
        </span>
        <span style={{ position: "absolute", right: 9, color: C.subDim }}>▾</span>
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%" }}
        aria-label="选择模型"
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.displayName}
          </option>
        ))}
      </select>
    </div>
  );
}

function IconPill({
  children,
  onClick,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{ ...pillBase, cursor: onClick ? "pointer" : "default" }}
    >
      {children}
    </button>
  );
}

// ---------------- styles ----------------

const sectionLabel: React.CSSProperties = {
  fontSize: "0.72rem",
  color: C.subDim,
  fontWeight: 600,
  padding: "0.3rem 0.6rem",
  letterSpacing: "0.02em",
};

const teamBeta: React.CSSProperties = {
  fontSize: "0.6rem",
  background: "#e5e7eb",
  color: "#6b7280",
  borderRadius: 4,
  padding: "1px 5px",
  fontWeight: 600,
};

const pillBase: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "0.32rem 0.7rem",
  background: "#f3f4f6",
  border: "none",
  borderRadius: 999,
  fontSize: "0.8rem",
  color: "#4b5563",
};

const switchPill: React.CSSProperties = {
  ...pillBase,
  cursor: "pointer",
  border: `1px solid ${C.border}`,
  background: "#fff",
};

const sceneChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "0.42rem 0.9rem",
  background: "#fff",
  border: `1px solid ${C.border}`,
  borderRadius: 999,
  fontSize: "0.82rem",
  color: "#4b5563",
  cursor: "pointer",
};

const pluginCard: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
  padding: "0.85rem 0.95rem",
  background: "#fff",
  border: `1px solid ${C.border}`,
  borderRadius: 14,
  cursor: "pointer",
  textAlign: "left",
};

const pluginIcon: React.CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: 7,
  background: C.greenSoft,
  color: C.green,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const pluginTag: React.CSSProperties = {
  fontSize: "0.7rem",
  color: C.green,
  background: C.greenSoft,
  borderRadius: 999,
  padding: "0.12rem 0.5rem",
  alignSelf: "flex-start",
};
