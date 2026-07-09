// SkillStore 测试(M1 #24):loadSkills 主路径 + 自动选第一个 + 错误路径 + selectSkill。
//
// 注意:这是 renderer 端 zustand store,但 store 本身是纯 JS,在 node env 可跑(只要
// mock window.api)。组件层测试(SkillPicker / SkillInputForm)需要 jsdom env 配置,
// 留 follow-up(#24 不引入测试基础设施改动)。

import type { SkillManifest } from "@opentrad/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSkillStore } from "../src/renderer/stores/skill";

const mockSkill = (id: string, title: string): SkillManifest => ({
  id,
  title,
  version: "0.1.0",
  description: `mock ${id}`,
  category: "other",
  riskLevel: "read_only",
  allowedTools: [],
  inputs: [],
  outputs: [],
  promptTemplate: "prompt.md",
});

const skillListMock = vi.fn();

beforeEach(() => {
  useSkillStore.setState({
    skills: [],
    selectedId: null,
    loading: false,
    error: null,
  });
  // mock window.api(node env 下 window 不存在,挂 globalThis)
  (globalThis as { window?: unknown }).window = {
    api: { skill: { list: skillListMock } },
  };
  skillListMock.mockReset();
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("SkillStore", () => {
  it("loadSkills 主路径:拉数据成功 + 自动选第一个", async () => {
    skillListMock.mockResolvedValue([mockSkill("a", "Alpha"), mockSkill("b", "Beta")]);

    await useSkillStore.getState().loadSkills();

    const state = useSkillStore.getState();
    expect(state.skills).toHaveLength(2);
    expect(state.skills[0]?.id).toBe("a");
    expect(state.selectedId).toBe("a");
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("loadSkills 已选中 skill 时不覆盖 selectedId", async () => {
    useSkillStore.setState({ selectedId: "preset" });
    skillListMock.mockResolvedValue([mockSkill("a", "A")]);

    await useSkillStore.getState().loadSkills();

    expect(useSkillStore.getState().selectedId).toBe("preset");
  });

  it("loadSkills 失败时进 error state,loading=false", async () => {
    skillListMock.mockRejectedValue(new Error("ipc fail"));

    await useSkillStore.getState().loadSkills();

    const state = useSkillStore.getState();
    expect(state.error).toContain("ipc fail");
    expect(state.loading).toBe(false);
    expect(state.skills).toEqual([]);
  });

  it("loadSkills 空数组时 selectedId 仍为 null", async () => {
    skillListMock.mockResolvedValue([]);

    await useSkillStore.getState().loadSkills();

    expect(useSkillStore.getState().selectedId).toBeNull();
  });

  it("selectSkill 设置 selectedId", () => {
    useSkillStore.getState().selectSkill("xyz");
    expect(useSkillStore.getState().selectedId).toBe("xyz");

    useSkillStore.getState().selectSkill(null);
    expect(useSkillStore.getState().selectedId).toBeNull();
  });

  it("selectedSkill getter 返回 selectedId 对应的 manifest", async () => {
    skillListMock.mockResolvedValue([mockSkill("a", "Alpha"), mockSkill("b", "Beta")]);
    await useSkillStore.getState().loadSkills();
    useSkillStore.getState().selectSkill("b");

    expect(useSkillStore.getState().selectedSkill()?.id).toBe("b");
  });

  it("selectedSkill getter 在 selectedId 不存在时返回 undefined", () => {
    useSkillStore.setState({
      skills: [mockSkill("a", "A")],
      selectedId: "ghost",
    });
    expect(useSkillStore.getState().selectedSkill()).toBeUndefined();
  });
});
