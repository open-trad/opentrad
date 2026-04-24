// IPC handler 统一注册入口。启动时在 app.whenReady 里调一次。
// 新增 domain 时在此 register 进来。

import type { CCManager } from "@opentrad/cc-adapter";
import { registerCcHandlers } from "./cc";

export function registerIpcHandlers(manager: CCManager): void {
  registerCcHandlers(manager);
  // 后续 domain：skill / session / settings / risk-gate 在此注册
}
