// App（M0.5 界面改版）：agent-first 外贸工作台外壳。
//
// 转向后（ADR-001）：产品自带 agent runtime，模型走用户自己的 API key，不再以 Claude Code
// 安装/登录为 onboarding 前置——因此不再挂 CC 时代的 OnboardingGate/Header/PtyDrawer。
// 主界面 = AppShell（侧栏 + 首页 hero + 对话 + 插件页 + 设置）。
// RiskGate 弹窗全局挂载（对外副作用动作的业务级确认，与 agent loop 的工具审批钩子对接）。

import type { ReactElement } from "react";
import { RiskGateOverlay } from "./features/risk-gate/RiskGateOverlay";
import { AppShell } from "./features/shell/AppShell";

export function App(): ReactElement {
  return (
    <div style={{ height: "100vh", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <AppShell />
      <RiskGateOverlay />
    </div>
  );
}
