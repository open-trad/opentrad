// CC 子进程任务的选项、handle、结果。对应 03-architecture.md §4.1。

import { z } from "zod";
import type { CCEvent } from "./cc-event";
import { ResultDataSchema } from "./cc-event";

// spawn 一个 CC 子进程所需的参数。
export const CCTaskOptionsSchema = z.object({
  sessionId: z.string(),
  prompt: z.string(),
  mcpConfigPath: z.string(),
  allowedTools: z.array(z.string()),
  cwd: z.string().optional(),
  model: z.enum(["default", "haiku", "sonnet", "opus"]).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions"]).optional(),
  resume: z.boolean().optional(),
});

export type CCTaskOptions = z.infer<typeof CCTaskOptionsSchema>;

// CCManager.startTask() 返回的运行时 handle。
// 包含流式事件和控制方法——函数签名无法用 zod 校验，保留纯 TS interface。
export interface CCTaskHandle {
  sessionId: string;
  pid: number;
  events: AsyncIterable<CCEvent>;
  cancel(): Promise<void>;
  result(): Promise<CCResult>;
}

// 任务最终结果。架构文档未直列字段，这里按 result 事件 + 元信息合理补全：
// 以 sessionId 关联、status 区分成功失败、data 透传 result 事件原 payload、
// exitCode 记录子进程退出码（便于上层判断是否异常退出）。
export const CCResultSchema = z.object({
  sessionId: z.string(),
  status: z.enum(["success", "error"]),
  data: ResultDataSchema,
  exitCode: z.number().int(),
});

export type CCResult = z.infer<typeof CCResultSchema>;
