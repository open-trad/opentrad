// SkillStore (M1 #24 / open-trad/opentrad#24)。
//
// Zustand store 维护 skill 列表 + 当前选中。startup 时 loadSkills() 从 IPC 拉一次。
// M1 范围:loadSkills + selectSkill;**enableSkill / disableSkill 留 M2**(用户主动
// 管理 skill 列表时再做,M1 只展示 builtin + 不暴露禁用 UI)。
//
// 03-architecture.md §六 SkillStore 设计:store 是 source of truth,组件 subscribe。

import type { SkillManifest } from "@opentrad/shared";
import { create } from "zustand";

interface SkillStoreState {
  skills: SkillManifest[];
  selectedId: string | null;
  // M1 #29 12b:历史回放选中的 sessionId(null = chat 当前;string = 回放历史)。
  // selectSkill 时清空,回到 form/chat;resumeSession 时设置,SkillWorkArea 进 replay。
  replaySessionId: string | null;
  loading: boolean;
  error: string | null;
  loadSkills: () => Promise<void>;
  selectSkill: (id: string | null) => void;
  resumeSession: (sessionId: string | null) => void;
  // 选中 skill 的 manifest(派生 getter)
  selectedSkill: () => SkillManifest | undefined;
}

export const useSkillStore = create<SkillStoreState>((set, get) => ({
  skills: [],
  selectedId: null,
  replaySessionId: null,
  loading: false,
  error: null,
  loadSkills: async () => {
    set({ loading: true, error: null });
    try {
      const skills = await window.api.skill.list();
      set({ skills, loading: false });
      // 自动选第一个(M1 D-pre-3:只 1 个 skill)
      if (skills.length > 0 && get().selectedId === null) {
        set({ selectedId: skills[0]?.id ?? null });
      }
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  },
  selectSkill: (id) => set({ selectedId: id, replaySessionId: null }),
  resumeSession: (sessionId) => set({ replaySessionId: sessionId }),
  selectedSkill: () => {
    const { skills, selectedId } = get();
    return skills.find((s) => s.id === selectedId);
  },
}));
