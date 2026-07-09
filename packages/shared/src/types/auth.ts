// 登录流程 IPC 协议(M1 #22 / open-trad/opentrad#22 OnboardingStep2)。
// 03-architecture.md §7.1 OnboardingStep2 + 02-mvp-slicing F1.3 + F6.2。
//
// 两种登录方式(issue body):
// - claudeai:`claude auth login --claudeai` 浏览器登录(主流,Subscription)
// - apikey:`claude auth login --apiKey <KEY>` API key 登录(备选,API key 用户)
//
// **绝对不读 ~/.claude/.credentials.json**(SECURITY 红线 + retrospective 反复强调)。
// 登录态完全由 CC 自己管,我们只通过 `claude auth status --text` 询问。

import { z } from "zod";

// auth:start-login-flow(Renderer → Main)
// 主进程通过 PtyManager spawn `claude auth login ...`,返回 ptyId 让 renderer:
// 1. 用 TerminalPane 渲染 PTY 输出(诊断 + URL 上下文)
// 2. 用 regex 提取 https://claude.ai/... URL,渲染"打开浏览器"按钮
// 3. 用户登录后 5s polling cc:status 检测 loggedIn=true 自动跳 step 3
// renderer 取消时调 pty:kill(已存在的 #20 channel)kill ptyId 关联的 PTY。
export const AuthStartLoginFlowRequestSchema = z.object({
  method: z.enum(["claudeai", "apikey"]).default("claudeai"),
  // 仅 method='apikey' 时使用;UI 输入框收集后传过来
  apiKey: z.string().optional(),
});

export const AuthStartLoginFlowResponseSchema = z.object({
  ptyId: z.string(),
});

export type AuthStartLoginFlowRequest = z.infer<typeof AuthStartLoginFlowRequestSchema>;
export type AuthStartLoginFlowResponse = z.infer<typeof AuthStartLoginFlowResponseSchema>;

// shell:open-external(Renderer → Main)
// 主进程用 electron shell.openExternal(url) 打开系统默认浏览器。
// 比 renderer 直接 window.open 更稳(明确走系统浏览器,不在 app 内 embed)。
// URL 来源:LoginStep 从 PTY 输出 regex 提取的 https://claude.ai/... 链接。
export const ShellOpenExternalRequestSchema = z.object({
  url: z.url(),
});

export type ShellOpenExternalRequest = z.infer<typeof ShellOpenExternalRequestSchema>;
