// LeftSidebar(M1 #29 12b):左栏组合 SkillPicker(顶)+ HistoryList(底)。
// SkillPicker flex 1.2 / HistoryList flex 1(skill 优先,history 副)。

import type { ReactElement } from "react";
import { HistoryList } from "./HistoryList";
import { SkillPicker } from "./SkillPicker";

export function LeftSidebar(): ReactElement {
  return (
    <aside style={containerStyle}>
      <div style={{ flex: 1.2, display: "flex", minHeight: 0 }}>
        <SkillPicker />
      </div>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <HistoryList />
      </div>
    </aside>
  );
}

const containerStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  background: "#f8fafc",
  borderRight: "1px solid #e5e7eb",
  overflow: "hidden",
};
