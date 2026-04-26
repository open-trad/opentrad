// SkillWorkArea(M1 #24):中栏容器。
//
// 状态机:
// - empty:未选 skill — 提示"请从左栏选 skill"
// - form:已选 skill,展示 SkillInputForm — 用户填表单
// - chat:表单提交后,展示对话流(从 cc:start-task 真实拉起,M1 #26 已接通)
//
// D-M1-3:输入表单与对话流在同一中栏(选中 skill 后展开表单,提交后表单替换为对话流),
// 不走独立路由。
//
// M1 #24 范围:接通真实 cc.startTask + 复用 M0 EventList 视觉(对话流)。
// M1 #29 (#29) 时整个 chat 视图升级(Markdown 渲染 / 多轮 / history)。

import type { CCEvent, SkillManifest } from "@opentrad/shared";
import { type ReactElement, useEffect, useState } from "react";
import { MessageBubble } from "../../components/chat/MessageBubble";
import { ToolCallCard } from "../../components/chat/ToolCallCard";
import { ToolResultCard } from "../../components/chat/ToolResultCard";
import { useSkillStore } from "../../stores/skill";
import { SkillInputForm } from "./SkillInputForm";

type WorkPhase =
  | { kind: "empty" }
  | { kind: "form"; skill: SkillManifest }
  | {
      kind: "chat";
      skill: SkillManifest;
      sessionId: string;
      events: CCEvent[];
      finished: boolean;
      success?: boolean;
    };

export function SkillWorkArea(): ReactElement {
  const { selectedId, skills } = useSkillStore();
  const selectedSkill = skills.find((s) => s.id === selectedId);

  const [phase, setPhase] = useState<WorkPhase>({ kind: "empty" });

  // selectedSkill 变化时重置 phase 为 form(若有 skill)或 empty
  useEffect(() => {
    if (selectedSkill) {
      setPhase((prev) => {
        // 同一 skill 已在 chat 中,不重置
        if (prev.kind === "chat" && prev.skill.id === selectedSkill.id) return prev;
        return { kind: "form", skill: selectedSkill };
      });
    } else {
      setPhase({ kind: "empty" });
    }
  }, [selectedSkill]);

  // 订阅 cc:event 流(chat 阶段)
  useEffect(() => {
    if (phase.kind !== "chat") return;
    const sessionId = phase.sessionId;
    const off = window.api.cc.onEvent((evt) => {
      setPhase((prev) => {
        if (prev.kind !== "chat" || prev.sessionId !== sessionId) return prev;
        const next: typeof prev = { ...prev, events: [...prev.events, evt] };
        if (evt.type === "result") {
          next.finished = true;
          next.success = evt.subtype === "success";
        }
        return next;
      });
    });
    return off;
  }, [phase]);

  const handleSubmit = async (
    skill: SkillManifest,
    inputs: Record<string, unknown>,
  ): Promise<void> => {
    // 设置 chat phase(sessionId 占位 "pending",真实在响应里覆盖)
    setPhase({
      kind: "chat",
      skill,
      sessionId: "pending",
      events: [],
      finished: false,
    });
    try {
      const { sessionId } = await window.api.cc.startTask({
        skillId: skill.id,
        inputs,
      });
      setPhase((prev) =>
        prev.kind === "chat" && prev.skill.id === skill.id ? { ...prev, sessionId } : prev,
      );
    } catch (err) {
      console.error("[skill-work-area] startTask failed", err);
      setPhase({ kind: "form", skill });
    }
  };

  const backToForm = (): void => {
    if (phase.kind === "chat") {
      setPhase({ kind: "form", skill: phase.skill });
    }
  };

  // ----- 渲染 -----

  if (phase.kind === "empty") {
    return (
      <main style={mainStyle}>
        <div style={emptyStyle}>请从左栏选择一个 skill 开始</div>
      </main>
    );
  }

  if (phase.kind === "form") {
    return (
      <main style={mainStyle}>
        <div style={contentStyle}>
          <SkillHeader skill={phase.skill} />
          <SkillInputForm skill={phase.skill} onSubmit={(i) => void handleSubmit(phase.skill, i)} />
        </div>
      </main>
    );
  }

  // chat
  return (
    <main style={mainStyle}>
      <div style={contentStyle}>
        <SkillHeader
          skill={phase.skill}
          rightSlot={
            <button
              type="button"
              onClick={backToForm}
              disabled={!phase.finished}
              style={{
                background: "white",
                color: "#475569",
                border: "1px solid #e5e7eb",
                padding: "0.4rem 0.9rem",
                borderRadius: 6,
                cursor: phase.finished ? "pointer" : "not-allowed",
                fontSize: "0.85rem",
                fontFamily: "inherit",
              }}
            >
              {phase.finished ? "← 重新发送" : "进行中…"}
            </button>
          }
        />
        <EventStream events={phase.events} />
        {phase.finished ? (
          <div
            style={{
              marginTop: "1rem",
              fontSize: "0.85rem",
              color: phase.success ? "#166534" : "#b91c1c",
            }}
          >
            {phase.success ? "✓ 任务完成" : "× 任务失败"}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function SkillHeader({
  skill,
  rightSlot,
}: {
  skill: SkillManifest;
  rightSlot?: ReactElement;
}): ReactElement {
  return (
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        marginBottom: "1.25rem",
        paddingBottom: "1rem",
        borderBottom: "1px solid #e5e7eb",
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: "1.25rem", color: "#111827" }}>{skill.title}</h2>
        <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem", color: "#6b7280" }}>
          {skill.description}
        </p>
      </div>
      {rightSlot}
    </header>
  );
}

// 简化对话流:复用 M0 EventList 的样式精简版(M1 #29 时升级 ChatLayout)
function EventStream({ events }: { events: CCEvent[] }): ReactElement {
  if (events.length === 0) {
    return (
      <div style={{ color: "#9ca3af", padding: "2rem 0", fontSize: "0.9rem" }}>
        等待 Claude Code 响应…
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {events.map((evt, i) => (
        <EventCard
          // biome-ignore lint/suspicious/noArrayIndexKey: events 顺序追加,index 即唯一稳定 key
          key={i}
          evt={evt}
        />
      ))}
    </div>
  );
}

function EventCard({ evt }: { evt: CCEvent }): ReactElement | null {
  // M1 #29 12a:升级 EventCard 用 MessageBubble / ToolCallCard / ToolResultCard。
  // M0 简版的 inline 渲染替换为专用组件,markdown / 代码块 / 表格 / 工具卡片完整支持。
  if (evt.type === "assistant_text") {
    return <MessageBubble kind="text" content={evt.text} />;
  }
  if (evt.type === "assistant_thinking") {
    return <MessageBubble kind="thinking" content={evt.thinking} />;
  }
  if (evt.type === "assistant_tool_use") {
    return <ToolCallCard toolName={evt.name} toolUseId={evt.toolUseId} input={evt.input} />;
  }
  if (evt.type === "tool_result") {
    return <ToolResultCard toolUseId={evt.toolUseId} content={evt.content} isError={evt.isError} />;
  }
  if (evt.type === "result") {
    return null; // result 在外层 finished 标显示
  }
  // system / rate_limit_event / unknown:最简标 type(信息密度低)
  return (
    <div
      style={{
        padding: "0.4rem 0.7rem",
        borderRadius: 6,
        fontSize: "0.7rem",
        background: "#f8fafc",
        color: "#94a3b8",
        border: "1px solid #e2e8f0",
        fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      }}
    >
      {evt.type}
    </div>
  );
}

const mainStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  background: "#fff",
};

const contentStyle: React.CSSProperties = {
  maxWidth: 760,
  margin: "0 auto",
  padding: "2rem",
};

const emptyStyle: React.CSSProperties = {
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#9ca3af",
  fontSize: "0.95rem",
};
