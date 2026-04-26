// App 组件 — M1 #24 (open-trad/opentrad#24) 三栏布局重构:
// - Header(状态栏 + #22 未登录入口)
// - 左:SkillPicker(M1 #24)
// - 中:SkillWorkArea(M1 #24,选中 skill → 表单 → 提交后对话流;接通 #26 cc:start-task)
// - 底:PtyDrawer 折叠 terminal(M1 #20)
//
// M0 "Say Hi in Chinese" 按钮 + EventList 顶层挂载已删除 — startTask 由 SkillWorkArea
// 内部触发,事件流在 SkillWorkArea EventStream 渲染。M1 #29 (#29) 时升级 ChatLayout。

import type { CCStatus } from "@opentrad/shared";
import { Settings } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { SkillPicker } from "./components/layout/SkillPicker";
import { TerminalPane } from "./components/ui/TerminalPane";
import { OnboardingGate } from "./features/onboarding/OnboardingGate";
import { RiskGateOverlay } from "./features/risk-gate/RiskGateOverlay";
import { SettingsRiskOverlay } from "./features/settings/SettingsRiskOverlay";
import { SkillWorkArea } from "./features/skills/SkillWorkArea";

type CcStatusState =
  | { kind: "loading" }
  | { kind: "ready"; data: CCStatus }
  | { kind: "error"; message: string };

export function App(): ReactElement {
  return (
    <>
      <OnboardingGate>
        <MainApp />
      </OnboardingGate>
      {/* RiskGate 弹窗(M1 #28):全局挂载,不论 onboarding 阶段都能弹(理论上 onboarding
          阶段不会触发 review tool,但留全局挂载更稳)。订阅 IPC channel risk-gate:confirm */}
      <RiskGateOverlay />
    </>
  );
}

function MainApp(): ReactElement {
  const [ccStatus, setCcStatus] = useState<CcStatusState>({ kind: "loading" });
  // PTY 面板默认折叠(M1 #20 / 02 F1.4)
  const [ptyOpen, setPtyOpen] = useState(false);
  // settings/risk modal(M1 #28 阶段 4):Header 齿轮按钮触发
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 加载 CC 状态(轮询 onStatus 由 #21 detect loop / 状态栏触发更新)
  useEffect(() => {
    let cancelled = false;
    window.api.cc
      .status()
      .then((data) => {
        if (!cancelled) setCcStatus({ kind: "ready", data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setCcStatus({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#333",
      }}
    >
      <Header ccStatus={ccStatus} onOpenSettings={() => setSettingsOpen(true)} />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <SkillPicker />
        <SkillWorkArea />
      </div>
      <PtyDrawer open={ptyOpen} onToggle={() => setPtyOpen((v) => !v)} />
      <SettingsRiskOverlay open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

// 底部折叠 Terminal 面板(M1 #20)。默认折叠,点"打开 terminal"才挂载 TerminalPane
// (挂载时才 spawn PTY;折叠回去会 unmount → kill PTY,避免后台 shell 长留)。
function PtyDrawer({ open, onToggle }: { open: boolean; onToggle: () => void }): ReactElement {
  return (
    <div style={{ borderTop: "1px solid #e5e7eb" }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: "100%",
          padding: "0.4rem 1rem",
          textAlign: "left",
          background: "#f8fafc",
          border: "none",
          borderBottom: open ? "1px solid #e5e7eb" : "none",
          cursor: "pointer",
          fontSize: "0.85rem",
          color: "#475569",
        }}
      >
        {open ? "▼ 关闭 terminal" : "▶ 打开 terminal"}
      </button>
      {open ? <TerminalPane height={280} /> : null}
    </div>
  );
}

function Header({
  ccStatus,
  onOpenSettings,
}: {
  ccStatus: CcStatusState;
  onOpenSettings: () => void;
}): ReactElement {
  return (
    <header
      style={{
        padding: "1rem 2rem",
        borderBottom: "1px solid #e5e7eb",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <h1 style={{ fontSize: "1.5rem", margin: 0 }}>OpenTrad</h1>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", fontSize: "0.85rem" }}>
        <CcStatusInline state={ccStatus} />
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Risk 设置"
          title="Risk 设置"
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            padding: "0.25rem",
            color: "#6b7280",
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <Settings size={16} />
        </button>
      </div>
    </header>
  );
}

function CcStatusInline({ state }: { state: CcStatusState }): ReactElement {
  if (state.kind === "loading") {
    return <span style={{ color: "#999" }}>检测中...</span>;
  }
  if (state.kind === "error") {
    return <span style={{ color: "#b91c1c" }}>IPC 错误：{state.message}</span>;
  }
  const s = state.data;
  if (!s.installed) {
    return <span style={{ color: "#92400e" }}>CC 未安装</span>;
  }
  if (!s.loggedIn) {
    // M1 #22:未登录时提供"点击登录"入口,reset onboarded=false + reload renderer
    // 让 OnboardingGate 重新走 install/login 决策树进 LoginStep。
    // M2 视需求改为更平滑路径(无需 reload,直接挂模态登录组件;
    // m1_retrospective_followups #6)。
    const handleLoginClick = async (): Promise<void> => {
      try {
        await window.api.settings.set("onboarded", false);
      } finally {
        window.location.reload();
      }
    };
    return (
      <span style={{ color: "#92400e" }}>
        v{s.version} · 未登录,
        <button
          type="button"
          onClick={() => void handleLoginClick()}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            color: "#2563eb",
            textDecoration: "underline",
            cursor: "pointer",
            fontSize: "0.85rem",
            fontFamily: "inherit",
          }}
        >
          点击登录
        </button>
      </span>
    );
  }
  const methodLabel = s.authMethod === "subscription" ? "订阅" : "API";
  return (
    <span style={{ color: "#166534" }}>
      v{s.version} · {s.email ?? "(?)"}（{methodLabel}）
    </span>
  );
}
