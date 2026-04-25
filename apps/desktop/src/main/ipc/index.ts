// IPC handler 统一注册入口。启动时在 app.whenReady 里调一次。
// 新增 domain 时在此 register 进来。

import type { CCManager } from "@opentrad/cc-adapter";
import type { DbServices } from "../services/db";
import { registerCcHandlers } from "./cc";
import { registerInstalledSkillHandlers } from "./installed-skill";
import { registerSessionHandlers } from "./session";
import { registerSettingsHandlers } from "./settings";

export function registerIpcHandlers(manager: CCManager, db: DbServices): void {
  registerCcHandlers(manager);
  registerSessionHandlers(db);
  registerSettingsHandlers(db);
  registerInstalledSkillHandlers(db);
  // 后续 domain：skill / risk-gate / pty / installer 在此注册
}
