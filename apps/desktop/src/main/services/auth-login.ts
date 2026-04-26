// CC 登录命令封装(M1 #22 / open-trad/opentrad#22)。
//
// 跨平台一致:`claude auth login --claudeai` / `claude auth login --apiKey <KEY>`。
// 通过 PtyManager spawn(让 renderer 看到 stdout 上的 https://claude.ai/... URL)。
// 不调用 ~/.claude/* 任何文件,登录态由 CC 自己写 Keychain / 我们后续 detect 时
// 通过 `claude auth status --text` 询问(cc-adapter getAuthStatus M0 已就位)。

export interface LoginCommand {
  command: string;
  args: string[];
}

// 默认 binary 名 'claude'(沿 cc-adapter getAuthStatus 同款约定)。
// dev / 真机若 CC 在非默认路径,M1 不暴露配置;M2 视用户反馈考虑 PATH override。
const DEFAULT_CC_BINARY = "claude";

export function getClaudeAiLoginCommand(binary = DEFAULT_CC_BINARY): LoginCommand {
  return {
    command: binary,
    args: ["auth", "login", "--claudeai"],
  };
}

export function getApiKeyLoginCommand(apiKey: string, binary = DEFAULT_CC_BINARY): LoginCommand {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("apiKey is required for apikey login mode");
  }
  return {
    command: binary,
    // CC apiKey 模式可走 stdin 也可 --apiKey 参数;选 --apiKey 让 PTY 输出
    // 提示更清晰(stdin 模式 PTY 输出可能是交互 prompt 不便 UI 展示)
    args: ["auth", "login", "--apiKey", apiKey],
  };
}

// PTY 输出里的 claude.ai 登录 URL 提取(供 LoginStep 单测复用 + 留 future 可能的
// 主进程提取需求)。M1 主路径在 renderer 提取(更接近 UI 渲染时机)。
//
// 真实 URL 形如 `https://claude.ai/oauth/...?token=xxx`,可能被 ANSI 颜色码 / 换行
// 包围。char set 用 RFC 3986 unreserved + reserved 子集,排除 ANSI 控制字符 / 空白。
const CLAUDE_AI_URL_REGEX = /https:\/\/claude\.ai\/[\w\-./~:?#@!$&'()*+,;=%]+/g;

export function extractClaudeAiUrl(text: string): string | undefined {
  const matches = text.match(CLAUDE_AI_URL_REGEX);
  if (!matches || matches.length === 0) return undefined;
  // 多个 match 时取第一个(实测 CC 输出只有一个 OAuth URL)
  return matches[0];
}
