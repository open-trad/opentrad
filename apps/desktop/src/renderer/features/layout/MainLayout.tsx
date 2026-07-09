// MainLayout(M1 #29 12a):三栏可拖拽布局。
//
// react-resizable-panels:Panel(defaultSize / minSize)+ PanelResizeHandle 拖拽条。
// onLayout debounce 500ms → settings 表持久化(通报点 4 持久化要求)。
//
// 三栏:
// - 左:SkillPicker(20% / min 15)
// - 中:SkillWorkArea(60% / min 30)
// - 右:placeholder "右栏(M2 浏览器预览)"(20% / min 0,可拖到隐藏)
//
// **D9-1 决策**:不用 PanelGroup 的 storage prop(它是 sync API 跟 settings async
// IPC 冲突),改用 onLayout + 启动时 settings.get 异步加载 default sizes 模式。

import { type ReactElement, useEffect, useRef, useState } from "react";
import { Group, type Layout, Panel, Separator } from "react-resizable-panels";
import { LeftSidebar } from "../../components/layout/LeftSidebar";
import { AgentChatPanel } from "../agent/AgentChatPanel";
import { SkillWorkArea } from "../skills/SkillWorkArea";

const LAYOUT_KEY = "ui.layoutWidths";
// v4 Layout 形态:{ [panelId]: sizePercent }。三栏 panelId:left / center / right。
const DEFAULT_LAYOUT: Layout = { left: 20, center: 60, right: 20 };
const DEBOUNCE_MS = 500;
const GROUP_ID = "main-layout";

// 中栏模式（M0 spike）：skill = 原有 CC 通道；agent = 自建 loop 对话。
// 顶部轻量 toggle 切换，不动路由（沿 D9-1 无 router 决策）。
type CenterMode = "skill" | "agent";

export function MainLayout(): ReactElement | null {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [centerMode, setCenterMode] = useState<CenterMode>("skill");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 启动时异步加载持久化布局
  useEffect(() => {
    let cancelled = false;
    void window.api.settings
      .get(LAYOUT_KEY)
      .then((v) => {
        if (cancelled) return;
        if (typeof v === "string") {
          try {
            const parsed = JSON.parse(v);
            // 形态校验:object,所有 value 是 number
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed) &&
              Object.values(parsed).every((n) => typeof n === "number")
            ) {
              setLayout(parsed as Layout);
              return;
            }
          } catch {}
        }
        setLayout(DEFAULT_LAYOUT);
      })
      .catch(() => {
        if (!cancelled) setLayout(DEFAULT_LAYOUT);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLayoutChange = (newLayout: Layout): void => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void window.api.settings
        .set(LAYOUT_KEY, JSON.stringify(newLayout))
        .catch((err) => console.error("[main-layout] persist failed", err));
    }, DEBOUNCE_MS);
  };

  // 加载中:占位空白(避免 Group 用错 defaultLayout)
  if (!layout) {
    return <div style={{ flex: 1, display: "flex" }} />;
  }

  return (
    <Group
      orientation="horizontal"
      id={GROUP_ID}
      defaultLayout={layout}
      onLayoutChange={handleLayoutChange}
      style={{ flex: 1, display: "flex" }}
    >
      <Panel id="left" minSize={15} maxSize={40}>
        <div style={paneStyle}>
          <LeftSidebar />
        </div>
      </Panel>
      <Separator id="sep-left" style={resizeHandleStyle} />
      <Panel id="center" minSize={30}>
        <div style={paneStyle}>
          <div style={modeBarStyle}>
            <ModeButton active={centerMode === "skill"} onClick={() => setCenterMode("skill")}>
              Skill 模式
            </ModeButton>
            <ModeButton active={centerMode === "agent"} onClick={() => setCenterMode("agent")}>
              Agent 对话（M0）
            </ModeButton>
          </div>
          {centerMode === "skill" ? <SkillWorkArea /> : <AgentChatPanel />}
        </div>
      </Panel>
      <Separator id="sep-right" style={resizeHandleStyle} />
      <Panel id="right" minSize={0}>
        <div style={{ ...paneStyle, ...rightPaneStyle }}>
          <div style={rightPaneInnerStyle}>
            <h3 style={{ margin: "0 0 0.5rem", fontSize: "0.9rem", color: "#475569" }}>右栏</h3>
            <p style={{ margin: 0, fontSize: "0.8rem", color: "#94a3b8" }}>
              M2 浏览器预览(可拖窄到隐藏)
            </p>
          </div>
        </div>
      </Panel>
    </Group>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        padding: "0.45rem 0.8rem",
        fontSize: "0.8rem",
        cursor: "pointer",
        borderBottom: active ? "2px solid #2563eb" : "2px solid transparent",
        color: active ? "#2563eb" : "#6b7280",
        fontFamily: "inherit",
        fontWeight: active ? 500 : 400,
      }}
    >
      {children}
    </button>
  );
}

const modeBarStyle: React.CSSProperties = {
  display: "flex",
  gap: "0.25rem",
  padding: "0 0.75rem",
  borderBottom: "1px solid #e5e7eb",
  background: "#fff",
  flexShrink: 0,
};

const paneStyle: React.CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const rightPaneStyle: React.CSSProperties = {
  background: "#f8fafc",
  borderLeft: "1px solid #e5e7eb",
};

const rightPaneInnerStyle: React.CSSProperties = {
  padding: "1rem",
  color: "#475569",
};

const resizeHandleStyle: React.CSSProperties = {
  width: 4,
  background: "#e5e7eb",
  cursor: "col-resize",
  transition: "background 0.15s",
};
