// CC 安装命令封装（M1 #21 / open-trad/opentrad#21）。
//
// 跨平台支持矩阵（A3 决策）：
// - macOS / Linux：自动安装 → `bash -c 'curl -fsSL https://claude.ai/install.sh | bash'`
//   通过 PTY spawn，让 renderer 的 TerminalPane 实时显示进度
// - Windows：**降级**——Anthropic 当前没有官方一键安装脚本，UI 引导用户去
//   docs.claude.com 手动装。auto-install 不暴露按钮，避免误用
//
// 隐私 / 安全：
// - 安装命令直接来自 claude.ai 官方域名，UI 上明示让用户读完再决定
// - 不读 ~/.claude / ~/.config/claude / Keychain（红线）
// - 不写凭证文件，安装结束 CC 自己管登录态（M1 #22 / open-trad/opentrad#22）

export interface InstallerCommand {
  command: string;
  args: string[];
}

export interface PlatformInstallSupport {
  supportsAutoInstall: boolean;
  manualInstallUrl: string;
  platform: "darwin" | "linux" | "win32" | "other";
}

const MANUAL_INSTALL_URL = "https://docs.claude.com/en/docs/claude-code/quickstart";

export function getPlatformInstallSupport(): PlatformInstallSupport {
  const platform = normalizePlatform();
  return {
    supportsAutoInstall: platform === "darwin" || platform === "linux",
    manualInstallUrl: MANUAL_INSTALL_URL,
    platform,
  };
}

// 拼自动安装命令。Windows 不该走这条路径（caller 用 supportsAutoInstall 守门）。
// 命令显式用 bash -c "..." 形式，避免 shell 解析陷阱（pipe / quote 都被 bash 自己处理）。
export function getAutoInstallCommand(): InstallerCommand {
  if (!getPlatformInstallSupport().supportsAutoInstall) {
    throw new Error("auto-install is not supported on this platform; use manual URL");
  }
  return {
    command: "/bin/bash",
    args: ["-c", "curl -fsSL https://claude.ai/install.sh | bash"],
  };
}

function normalizePlatform(): PlatformInstallSupport["platform"] {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "win32";
  return "other";
}
