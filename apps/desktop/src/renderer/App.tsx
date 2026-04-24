// App 组件 — M0 占位：验证 Electron 窗口能渲染 React。
// 三栏布局、SkillPicker、Chat 等留到 Issue #7-#8 和后续里程碑。

import type { ReactElement } from "react";

export function App(): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#333",
      }}
    >
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>Hello OpenTrad</h1>
      <p style={{ color: "#666", fontSize: "0.95rem" }}>
        Electron 主进程已启动，React renderer 已挂载。
      </p>
      <p style={{ color: "#999", fontSize: "0.85rem", marginTop: "1rem" }}>M0 骨架 — Issue #6</p>
    </div>
  );
}
