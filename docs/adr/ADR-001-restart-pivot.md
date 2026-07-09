# ADR-001：项目重启与架构转向

**状态**：已采纳
**日期**：2026-07-08
**决策人**：发起人（yrjm）
**背景材料**：多 agent 项目考古（4 读取方 + 合成）、四组事实核查、三视角独立架构方案 + 合成评审（存档于发起人会话工作流产物）

## 背景

OpenTrad 原方向（2026-04，见 opentrad-legacy 仓库与归档的 docs 仓库）："把 Claude Code 包装成外贸商家能上手的图形化 AI 工作台"，明确**不自建 agent runtime**。4 天冲刺完成 M0 + 95% 的 M1 后停摆。复盘结论：工程执行近乎完美，市场验证完全为零；原方向的三大产品赌注（商家已付 Claude 订阅、非技术用户能走通 CLI onboarding、skill 有用性）全部未验证。

## 决策

### D1：自建 agent runtime（架构立场反转）

产品自带完整 agent loop（会话、工具调度、任务执行），不再以 Claude Code 为大脑。技术选型：**Vercel AI SDK 6 ToolLoopAgent**，封装在 `packages/agent-core` 内部不外泄（硬约束 <2,500 行）；逃生门备选 pi-agent-core。M0 spike 验证两件事：Electron 打包兼容、审批钩子能承载完整审批语义——任一失败即切换。

### D2：模型层——API key 为根基，订阅为可选实验通道

事实核查（2026-07）：第三方裸复用 Claude 订阅 OAuth 已于 2026-04 被 Anthropic 封禁，2026-05 改 credit 制，2026-06 暂停执行——政策 5 个月变 3 次。结论：
- ApiKeyBackend 为默认（官方 @ai-sdk 包 + openai-compatible 覆盖 DeepSeek/通义/Moonshot）
- 订阅复用唯一合规通道是官方 Claude Code / Agent SDK 进程路径——**cc-adapter + stream-parser 因此不退役**，收编为 `SubscriptionBackend`（实验 flag，M5 放出，关掉不影响任何功能）
- 凭证一律 Electron safeStorage，SQLite 只存引用

### D3：目标用户从"不会代码的商家"改为"会开发、懂 AI 的外贸商家"

可 DIY（用户自行扩展 skill/连接器/挂 MCP server）是核心产品属性。发起人本人即目标用户，每个里程碑绑定发起人真实业务行为验收（详见重启计划的 dogfooding 节点与诚实闸门）。

### D4：选品数据走 bb-browser 站点适配器，不做第三方付费 API 默认路径，不对抗反爬

用用户自己浏览器的登录态（bb-browser，MIT，CDP 控制真实 Chrome，以 MCP server 方式接入 tool-host），在页面上下文内调站点内部 API。适配器生态复用社区 bb-sites（已有 taobao/aliexpress/amazon/ebay/jd），1688 适配器新写并贡献上游。降级链：bb-browser → Playwright（browser-tools）→ 第三方付费 API 留接口不实现。

### D5：skill 纯声明式、连接器是唯一带代码扩展形态

skill = YAML manifest + prompt 资产（skill-runtime 升级 v2：requires 依赖声明 + outputs 结构化 schema），零沙箱可开放分发。带代码的能力扩展只有连接器（规范 v1 见 `packages/connectors`）或用户自挂 MCP server。

### D6：仓库策略

新仓库沿用 open-trad/opentrad（旧仓库改名 opentrad-legacy 并归档，docs/skills/research 一并归档）；git 历史重新开始，旧历史在 legacy 仓库完整保留。旧 PR #51/#52 关闭不合并，打包配置留在 legacy 分支 `feat/issue-30b-electron-builder` 可摘取。apps/mcp-server 不迁移（新架构自己是 MCP client）。

## 后果

- 正面：产品命运不再绑定单一上游（CC 政策/行为变化）；模型可插拔产生真实用途（便宜模型跑选品、强模型跑 listing）；Risk Gate 从"隔着 CC 间接约束"变为 loop 内硬闸门
- 负面：自建 loop 引入上下文管理/错误恢复/成本控制的自担复杂度——对策是"刻意做笨"（滑动窗口截断 + 单次摘要 + 步数上限 + 预算硬顶）并冻结 backlog
- 迁移成本：desktop 的 IPC 接线从 cc.ts 换 agent.ts（M0-M1）；CC 专属 UI（安装向导检测、PTY 入口）收进开发者区域

## 里程碑与验收

见 `docs/design/restart-plan.md`（重启计划全文，含 M0-M5 切分、dogfooding 验收、kill criteria、不做清单）。
