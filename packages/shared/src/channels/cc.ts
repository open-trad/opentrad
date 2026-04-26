// CC(Claude Code)domain IPC channels(M1 #30 Part C TD-002 拆分)。
// 包含 CC 状态查询 / 任务启动取消 / 事件流推送 / 后台检测轮询。

export const CCChannels = {
  CCStatus: "cc:status",
  CCStartTask: "cc:start-task",
  CCCancelTask: "cc:cancel-task",
  CCEvent: "cc:event",
  CCDetectLoopStart: "cc:detect-loop-start",
  CCDetectLoopStop: "cc:detect-loop-stop",
} as const;
