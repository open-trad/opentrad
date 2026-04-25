// PTY IPC 协议（M1 #20 / #3）。
// 主进程封装 node-pty，渲染层用 xterm.js 显示，双向通信走 IPC。
//
// 通道方向：
// - pty:spawn / write / resize / kill：renderer → main（invoke）
// - pty:data / pty:exit：main → renderer（push）
//
// ptyId 是主进程生成的字符串（UUID），全局唯一标识一个 PTY 子进程。

import { z } from "zod";

// -------- pty:spawn（Renderer → Main） --------

export const PtySpawnRequestSchema = z.object({
  // 不传 command 时主进程选默认平台 shell：macOS=zsh、Linux=bash、Windows=pwsh→cmd
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  cols: z.number().int().positive().default(80),
  rows: z.number().int().positive().default(24),
});

export type PtySpawnRequest = z.infer<typeof PtySpawnRequestSchema>;

export const PtySpawnResponseSchema = z.object({
  ptyId: z.string(),
});

export type PtySpawnResponse = z.infer<typeof PtySpawnResponseSchema>;

// -------- pty:write（Renderer → Main） --------

export const PtyWriteRequestSchema = z.object({
  ptyId: z.string(),
  data: z.string(),
});

export type PtyWriteRequest = z.infer<typeof PtyWriteRequestSchema>;

// -------- pty:resize（Renderer → Main） --------

export const PtyResizeRequestSchema = z.object({
  ptyId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export type PtyResizeRequest = z.infer<typeof PtyResizeRequestSchema>;

// -------- pty:kill（Renderer → Main） --------

export const PtyKillRequestSchema = z.object({
  ptyId: z.string(),
  // POSIX 信号名（"SIGTERM" 默认）；Windows 上 node-pty 自己处理映射
  signal: z.string().optional(),
});

export type PtyKillRequest = z.infer<typeof PtyKillRequestSchema>;

// -------- pty:data（Main → Renderer push） --------

export const PtyDataEventSchema = z.object({
  ptyId: z.string(),
  data: z.string(),
});

export type PtyDataEvent = z.infer<typeof PtyDataEventSchema>;

// -------- pty:exit（Main → Renderer push） --------

export const PtyExitEventSchema = z.object({
  ptyId: z.string(),
  exitCode: z.number().int(),
  signal: z.number().int().optional(), // node-pty 给的 signal 是 number 或 0
});

export type PtyExitEvent = z.infer<typeof PtyExitEventSchema>;
