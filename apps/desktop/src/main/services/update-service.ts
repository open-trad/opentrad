// 更新检查（M0.5：检查 + 提示下载，非静默自动更新）。
//
// 未签名 macOS 应用无法用 electron-updater 静默安装（Squirrel.Mac 需签名），故采用
// 轻量方案：查 GitHub 最新 Release，比对版本，有新版则让 renderer 弹提示 + 一键打开下载页。
// 纯 HTTP GET GitHub API，无第三方后端。

import type { UpdateCheckResult } from "@opentrad/shared";

const RELEASES_API = "https://api.github.com/repos/open-trad/opentrad/releases/latest";

// 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等 0。仅比较 major.minor.patch。
function compareSemver(a: string, b: string): number {
  const pa = a
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = b
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

// 查 GitHub 最新 release 并与当前版本比对。失败返回 hasUpdate=false（不打扰）。
export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      return { hasUpdate: false, current: currentVersion, latest: null, url: null };
    }
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const latest = typeof data.tag_name === "string" ? data.tag_name : null;
    const url = typeof data.html_url === "string" ? data.html_url : null;
    const hasUpdate = latest !== null && compareSemver(latest, currentVersion) > 0;
    return { hasUpdate, current: currentVersion, latest, url };
  } catch {
    return { hasUpdate: false, current: currentVersion, latest: null, url: null };
  }
}

export { compareSemver };
