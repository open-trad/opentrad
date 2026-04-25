// CC 安装向导 IPC 协议（M1 #21 / open-trad/opentrad#21）。
// 03-architecture.md §7.1 OnboardingStep1 + 02-mvp-slicing F6.1 + F1.1。
//
// 跨平台支持矩阵（A3 决策落地）：
// - macOS / Linux：自动安装通过 PTY 跑 `curl -fsSL https://claude.ai/install.sh | bash`
// - Windows：**降级**——Anthropic 当前无官方一键脚本，UI 显示 docs.claude.com
//   链接 + "我已自己装好了" 重新检测按钮，不强求自动安装

import { z } from "zod";

// installer:supports-auto-install（Renderer → Main）
// 返回当前平台是否支持自动安装。Windows 永远 false（A3）；macOS / Linux 看
// 是否能找到 curl + bash（fresh 系统都有，理论返回 true）。
//
// renderer 用这个决定 InstallStep UI 显示哪条路径：
// - true → "一键安装"按钮 + TerminalPane（PTY 输出）
// - false → docs.claude.com 链接 + "我已装好"按钮

export const InstallerSupportsAutoInstallResponseSchema = z.object({
  supportsAutoInstall: z.boolean(),
  // 不支持时的指引（manualInstallUrl）。支持时也返回，作为 fallback。
  manualInstallUrl: z.string(),
  // 平台标识，UI 可以显示"在 Windows 上需要..."
  platform: z.enum(["darwin", "linux", "win32", "other"]),
});

export type InstallerSupportsAutoInstallResponse = z.infer<
  typeof InstallerSupportsAutoInstallResponseSchema
>;

// installer:run-cc-install（Renderer → Main）
// renderer 点"一键安装"后调。Main 通过 PTY spawn 安装脚本，返回 ptyId 让
// renderer 把 PTY 输出渲染到 TerminalPane。
//
// 安装结束（PTY 退出）renderer 可以触发 cc:detect-loop-start 自动轮询检测
// 是否装好（避免用户来回点"重新检测"）。

export const InstallerRunCcInstallResponseSchema = z.object({
  ptyId: z.string(),
});

export type InstallerRunCcInstallResponse = z.infer<typeof InstallerRunCcInstallResponseSchema>;

// cc:detect-loop-start（Renderer → Main）
// 启动后台轮询 detectInstallation()，每 intervalMs 跑一次，通过 cc:status
// channel 推送给 renderer。最长 maxDurationMs 后自动停（避免空跑）。
//
// renderer 在 install 完成 / 用户点"重新检测" / 点"我已装好"后启动；
// 检测到 installed=true 自动停止 + 推进到下一步（M1 #22 LoginStep）。

export const CCDetectLoopStartRequestSchema = z.object({
  intervalMs: z.number().int().positive().default(3000),
  maxDurationMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000), // 5 分钟兜底
});

export type CCDetectLoopStartRequest = z.infer<typeof CCDetectLoopStartRequestSchema>;
