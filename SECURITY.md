# 安全政策

## 支持版本

v1 开发阶段，暂无 stable release。所有 security fix 只会在 `main` 分支。

## 报告漏洞

**不要**在公开 Issue 里报告安全漏洞。

请在 GitHub 的 Security 页面使用 [Private Vulnerability Reporting](https://github.com/open-trad/opentrad/security/advisories/new) 提交。

报告应包含：
- 漏洞描述
- 复现步骤
- 影响范围
- 建议修复方案（可选）

我们会在 48 小时内确认收到，并保持沟通直到修复。

## 已知的安全边界

OpenTrad 的安全模型假设：
- 用户的操作系统未被攻破
- 用户的 Claude Code 凭证由 Claude Code 管理（Keychain 等），OpenTrad 不读取
- 用户对自己安装的第三方 skill 的代码负责

OpenTrad 不承诺防御：
- 物理接触攻击
- 操作系统级恶意软件
- 用户主动分享 `.opentrad/` 目录给不可信第三方导致的数据泄漏
