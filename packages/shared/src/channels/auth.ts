// Auth & Shell domain IPC channels(M1 #22 + M1 #29)。
// auth:start-login-flow:M1 #22 LoginStep 启动 PTY 跑 `claude auth login`。
// shell:open-external:打开系统默认浏览器(LoginStep + Markdown 链接 + Settings GitHub)。

export const AuthChannels = {
  AuthStartLoginFlow: "auth:start-login-flow",
  ShellOpenExternal: "shell:open-external",
} as const;
