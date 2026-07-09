// 更新检查结果（M0.5：检查 + 提示下载）。
export interface UpdateCheckResult {
  hasUpdate: boolean;
  current: string;
  latest: string | null; // 最新 release tag（如 v0.2.0）；查不到为 null
  url: string | null; // release 页面 URL
}
