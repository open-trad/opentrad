// skill:* IPC handlers(M1 #24 / open-trad/opentrad#24)。
//
// skill:list — renderer SkillStore 调,返回所有可加载的 skill manifest。
// 数据来源(M1 范围):
// 1. builtin skills:packages/skill-runtime/__fixtures__/(M1 占位用 fixture-skill;
//    真实 trade-email-writer 在 M1 #30 落地)
// 2. user skills:~/.opentrad/skills/(M1 不暴露导入 UI,但 loader 接口先就位)
//
// 加载失败的 skill(SkillLoadError)不返回 — UI 只展示能用的;失败的会 stderr 打日志,
// 后续 M1 #29 history 可能加错误展示。
// install / enable / disable 写操作 M1 不做,留 M2(用户主动管理 skill 列表时)。

import { homedir } from "node:os";
import { join } from "node:path";
import { IpcChannels, type SkillManifest } from "@opentrad/shared";
import { loadBuiltinSkills, loadUserSkills } from "@opentrad/skill-runtime";
import { app, ipcMain } from "electron";

// builtin path 解析:与 cc.ts 同款(app.getAppPath() + 上 2 层到 monorepo root)
// M1 #30 真打包时改用 process.resourcesPath / extraResources(packaged 模式)
function getBuiltinSkillsDir(): string {
  return join(app.getAppPath(), "..", "..", "packages", "skill-runtime", "__fixtures__");
}

// 用户 skill 目录(~/.opentrad/skills/);不存在视为空(M1 友好)
function getUserSkillsDir(): string {
  return join(homedir(), ".opentrad", "skills");
}

export function registerSkillHandlers(): void {
  ipcMain.handle(IpcChannels.SkillList, async (): Promise<SkillManifest[]> => {
    const builtin = loadBuiltinSkills(getBuiltinSkillsDir());
    const user = loadUserSkills(getUserSkillsDir());

    const results = [...builtin, ...user];
    const manifests: SkillManifest[] = [];
    for (const r of results) {
      if (r.ok) {
        manifests.push(r.skill.manifest);
      } else {
        // 失败的 skill stderr 打日志(M1 #29 可能加 UI 展示)
        console.warn(`[skill:list] skip skill at ${r.skillDir}: ${r.error.message}`);
      }
    }
    return manifests;
  });
}
