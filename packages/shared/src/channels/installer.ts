// Installer domain IPC channels(M1 #30 Part C TD-002 拆分)。
// M1 #21 CC install onboarding:平台支持探测 + 一键安装 PTY 触发。

export const InstallerChannels = {
  InstallerSupportsAutoInstall: "installer:supports-auto-install",
  InstallerRunCcInstall: "installer:run-cc-install",
} as const;
