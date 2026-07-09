// installed-skill:* IPC handlers。
// M1 #19 仅暴露 list（installed_skills 表 read-only 视图）；install / enable / disable 等
// 写操作在 M1 #23 / #6 (Skill runtime 后端) 接通时再加。

import { type InstalledSkillRow, IpcChannels } from "@opentrad/shared";
import { ipcMain } from "electron";
import type { DbServices } from "../services/db";

export function registerInstalledSkillHandlers(db: DbServices): void {
  ipcMain.handle(IpcChannels.InstalledSkillList, async (): Promise<InstalledSkillRow[]> => {
    return db.installedSkills.list();
  });
}
