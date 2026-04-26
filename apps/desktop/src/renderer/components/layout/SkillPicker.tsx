// SkillPicker(M1 #24):左侧栏,展示已启用 skill 列表。
//
// M1 D-pre-3:只显示 1 个 skill(fixture-skill 占位 trade-email-writer);
// 真实 trade-email-writer manifest 在 M1 #30 落地。
//
// 视觉:固定宽度 200px,顶部"Skills"标题,列表项 hover/selected 高亮。空态友好提示。

import { type ReactElement, useEffect } from "react";
import { useSkillStore } from "../../stores/skill";

const PICKER_WIDTH = 220;

export function SkillPicker(): ReactElement {
  const { skills, selectedId, loading, error, loadSkills, selectSkill } = useSkillStore();

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  return (
    <aside
      style={{
        width: PICKER_WIDTH,
        flexShrink: 0,
        borderRight: "1px solid #e5e7eb",
        background: "#f8fafc",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          padding: "0.75rem 1rem",
          fontSize: "0.85rem",
          fontWeight: 600,
          color: "#475569",
          borderBottom: "1px solid #e5e7eb",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        Skills
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "0.5rem 0" }}>
        {loading && skills.length === 0 ? (
          <div style={{ padding: "1rem", color: "#94a3b8", fontSize: "0.85rem" }}>加载中…</div>
        ) : null}

        {error ? (
          <div style={{ padding: "1rem", color: "#b91c1c", fontSize: "0.85rem" }}>
            加载失败:{error}
          </div>
        ) : null}

        {!loading && !error && skills.length === 0 ? (
          <div style={{ padding: "1rem", color: "#94a3b8", fontSize: "0.85rem" }}>
            暂无可用 skill
          </div>
        ) : null}

        {skills.map((skill) => {
          const isSelected = skill.id === selectedId;
          return (
            <button
              key={skill.id}
              type="button"
              onClick={() => selectSkill(skill.id)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "0.6rem 1rem",
                background: isSelected ? "#dbeafe" : "transparent",
                borderLeft: isSelected ? "3px solid #2563eb" : "3px solid transparent",
                border: "none",
                cursor: "pointer",
                fontSize: "0.9rem",
                color: isSelected ? "#1e3a8a" : "#111827",
                fontFamily: "inherit",
              }}
            >
              <div style={{ fontWeight: 500 }}>{skill.title}</div>
              <div
                style={{
                  fontSize: "0.75rem",
                  color: isSelected ? "#1e3a8a" : "#94a3b8",
                  marginTop: "0.15rem",
                }}
              >
                {skill.category}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
