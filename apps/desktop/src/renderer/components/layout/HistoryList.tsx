// HistoryList(M1 #29 12b):左栏会话历史。
//
// 数据:IPC session:list(50/页;M1 不分页,M2 加滚动加载)。
// 点击 → useSkillStore.resumeSession(id) → SkillWorkArea 进 replay phase。
// 当前 replaySessionId 高亮。
//
// 相对时间(刚刚 / 5 分钟前 / 2 小时前 / 3 天前 / YYYY-MM-DD)。

import type { SessionMeta } from "@opentrad/shared";
import { History } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { useSkillStore } from "../../stores/skill";

export function HistoryList(): ReactElement {
  const replaySessionId = useSkillStore((s) => s.replaySessionId);
  const resumeSession = useSkillStore((s) => s.resumeSession);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.api.session.list({ limit: 50, offset: 0 });
      setSessions(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 当 replaySessionId 切换(用户回放完毕回到 chat / 选其他 skill 清空时),
  // 列表数据本身不变,但 replay session 可能是新建的;每次清空时 reload 一次
  // (debounce 不重要,只在 user-actor 行为后)
  useEffect(() => {
    if (replaySessionId === null) {
      void reload();
    }
  }, [replaySessionId, reload]);

  return (
    <section style={sectionStyle}>
      <header style={headerStyle}>
        <History size={12} aria-hidden="true" style={{ marginRight: 4 }} />
        History
      </header>

      <div style={listStyle}>
        {loading && sessions.length === 0 ? <div style={emptyStyle}>加载中…</div> : null}
        {error ? <div style={{ ...emptyStyle, color: "#b91c1c" }}>加载失败:{error}</div> : null}
        {!loading && !error && sessions.length === 0 ? (
          <div style={emptyStyle}>暂无历史会话</div>
        ) : null}

        {sessions.map((s) => {
          const isSelected = s.id === replaySessionId;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => resumeSession(s.id)}
              style={{
                ...itemStyle,
                background: isSelected ? "#dbeafe" : "transparent",
                borderLeft: isSelected ? "3px solid #2563eb" : "3px solid transparent",
              }}
              title={s.title}
            >
              <div
                style={{
                  fontSize: "0.8rem",
                  color: isSelected ? "#1e3a8a" : "#1f2937",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {s.title}
              </div>
              <div
                style={{
                  fontSize: "0.7rem",
                  color: "#94a3b8",
                  marginTop: "0.15rem",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>{s.skillId ?? "—"}</span>
                <span>{relativeTime(s.updatedAt)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  // 超过 7 天显示 YYYY-MM-DD
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const sectionStyle: React.CSSProperties = {
  borderTop: "1px solid #e5e7eb",
  background: "#f8fafc",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0, // 允许 flex 子项 overflow scroll
};

const headerStyle: React.CSSProperties = {
  padding: "0.6rem 1rem",
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "#475569",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  borderBottom: "1px solid #e5e7eb",
  display: "flex",
  alignItems: "center",
};

const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "0.4rem 0",
};

const emptyStyle: React.CSSProperties = {
  padding: "1rem",
  color: "#94a3b8",
  fontSize: "0.8rem",
  textAlign: "center",
};

const itemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "0.5rem 0.85rem",
  border: "none",
  cursor: "pointer",
  fontFamily: "inherit",
  background: "transparent",
};
