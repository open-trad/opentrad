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
import { SkillPicker } from "../../components/layout/SkillPicker";
import { SkillWorkArea } from "../skills/SkillWorkArea";

const LAYOUT_KEY = "ui.layoutWidths";
// v4 Layout 形态:{ [panelId]: sizePercent }。三栏 panelId:left / center / right。
const DEFAULT_LAYOUT: Layout = { left: 20, center: 60, right: 20 };
const DEBOUNCE_MS = 500;
const GROUP_ID = "main-layout";

export function MainLayout(): ReactElement | null {
  const [layout, setLayout] = useState<Layout | null>(null);
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
          <SkillPicker />
        </div>
      </Panel>
      <Separator id="sep-left" style={resizeHandleStyle} />
      <Panel id="center" minSize={30}>
        <div style={paneStyle}>
          <SkillWorkArea />
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
