# OpenTrad 重启计划（方向重梳 + 技术方案）

## Context（为什么做这件事）

OpenTrad（github.com/open-trad）是发起人 2026-04-23 ~ 04-26 四天冲刺后停摆的开源项目。原定位："把 Claude Code 包装成外贸商家能上手的图形化 AI 工作台"——明确不自建 agent runtime、不做大脑，只做 Claude Code 的 Electron 图形宿主。

**停摆点考古结论**（多 agent 交叉核验）：M1 里程碑 13 个 issue 关了 12 个，最后两个 PR CI 全绿未合并，代码完成度 95%+，停在第一个必须人类亲手做的环节。约 15,500 行 TS/TSX、38 个测试文件，其中 95% 以上与"外贸"零绑定。原方向致命伤：零用户验证的先建后验（三大产品赌注全部未验证，research 仓库空置）。

**发起人重启原因**：原方向与真实想法不符——"大方向对但重点偏了"。

## 新方向（发起人逐项确认）

1. **架构立场反转**：产品自带完整 agent runtime（会话、agent loop、工具调用、任务执行都是自己的），不再围绕 Claude Code 做壳。参照 OpenClaw / Hermes 模式
2. **模型层可插拔**：API key 直连为根基（Anthropic/OpenAI/DeepSeek/通义/Moonshot）；订阅复用为可选通道。事实核查：裸复用订阅 OAuth 已于 2026-04 被 Anthropic 封禁，后改 credit 制又于 2026-06 暂停（5 个月变 3 次）——合规通道是官方 Claude Code/Agent SDK 进程路径，恰好是旧 cc-adapter 的现成实现
3. **目标用户变更**：从"不会代码的商家"→"具备一定开发能力、了解 AI/vibe coding 的外贸商家"。可 DIY（用户自行扩展 skill/连接器）是核心产品属性
4. **验证方式变更**：发起人自己就是外贸商家 = 第一个用户，每个里程碑绑定真实业务行为验收
5. **MVP 场景与顺序**（发起人拍板）：**选品/供应商先行**，listing 第二；邮件资产保留但不占 MVP 预算
6. **选品数据路径**（发起人指定）：基于 **bb-browser + bb-sites 站点适配器**——用用户自己浏览器的登录态，在页面上下文内调用站点内部 API（非 DOM 爬取、不对抗反爬）。已核实：bb-browser MIT 许可、CDP 控制真实 Chrome、可作 MCP server 集成、5.9k stars 活跃维护；zzhan111/bb-sites fork 已有 taobao/aliexpress/amazon/ebay/jd 电商适配器，**缺 1688（需新写并可贡献上游）**
7. **保留**：开源（AGPL-3.0）、Risk Gate 理念、Electron 桌面形态、TS monorepo

## 仓库策略（发起人拍板）

- **新仓库重开**，把可复用的包迁移过去；旧仓库归档保留
- 旧 PR #51/#52 **直接关闭**不合并（三位评审架构师原建议合并存档，尊重发起人决定；打包配置等代码仍在旧仓库分支上，M5 需要时可摘取）

## 资产迁移

| 旧仓库资产 | 处置 | 说明 |
|---|---|---|
| apps/desktop（Electron 壳、Chat UI、SQLite、Settings） | 迁移改造 | IPC 接线从 cc.ts 换 agent.ts；Settings 新增 Profile/凭证页 |
| packages/skill-runtime + YAML skill 规范 | 迁移升级 v2 | 新增 requires 依赖声明、outputs 结构化 schema；**skill = 纯声明式数据不含代码**（可开放分发的前提） |
| packages/risk-gate | 迁移零改动 | 挂到新 loop 的工具执行前钩子；stopBefore 落在连接器工具 manifest |
| packages/browser-tools（Playwright） | 迁移 | 进程内直挂 tool-host，作为 bb-browser 之外的兜底 |
| packages/cc-adapter + stream-parser | 迁移为可选订阅后端 | 收编进 model-providers 的 SubscriptionBackend，实验 flag，M5 才放出 |
| packages/shared 事件类型 | 迁移泛化 | cc-event 泛化为 provider 无关的 AgentEvent，desktop 持久化/回放改动最小 |
| skills/trade-email-writer | 迁移 | 作 Skill v2 规范参考实现，不占里程碑 |
| apps/mcp-server | 不迁移（封存） | 新架构自己是 MCP client，无需给自己开 server |

## 新架构（模块级）

**新增 4 个包**（延续 pnpm monorepo）：

- **packages/agent-core**（硬约束 <2,500 行）：基于 **Vercel AI SDK 6 ToolLoopAgent** 封装 AgentSession——会话生命周期、工具调度、stopWhen 步数上限、统一 AgentEvent 事件流、每步 SQLite checkpoint 崩溃可续、每步 usage 计量 + 会话预算硬顶。上下文管理刻意做笨（滑动窗口截断 + 超阈值单次摘要）。运行于 Electron utilityProcess。AI SDK 封在包内不外泄——升级隔离 + 换 **pi-agent-core（逃生门备选）** 的切换面
- **packages/model-providers**：ProviderProfile（provider + 凭证引用 + 模型偏好）+ 统一 ChatBackend 接口。ApiKeyBackend 默认（官方 @ai-sdk 包 + openai-compatible 一份代码接国产模型）；SubscriptionBackend 可选实验。凭证一律 Electron safeStorage（OS keychain），SQLite 只存引用
- **packages/tool-host**：三类工具统一挂载——内建工具（web fetch/search、文件、browser-tools）、连接器工具、**MCP client**（用户可挂任意 stdio/HTTP MCP server = day-1 的 DIY 主通道；**bb-browser 以 MCP server 方式接入**）。每个工具带 riskLevel + businessAction 元数据，调用前统一过 risk-gate
- **packages/connectors** + 连接器规范 v1：zod manifest 声明 auth 类型、动作、每动作 riskLevel/stopBefore；用户自带凭证。MVP 实现：sourcing 站点适配器组（经 bb-browser）、shopify-admin（M4）

**数据流**：Chat 输入 → IPC → agent-core（utilityProcess）建 AgentSession（skill systemPrompt + allowedTools + 选定 Profile）→ ToolLoopAgent 循环 → 每次工具调用先过 risk-gate.check() → AgentEvent 流回 renderer 渲染并落库 → 结构化 outputs 落**本地贸易知识库**（SQLite 扩 products/suppliers/listings/price_quotes 表——精确结构化查询，非向量记忆）。

## 里程碑（约 9–11 周；纪律：每个 ≤3 周、独立可发布、绑定 dogfooding 验收）

**M0 · 新仓库奠基 + 换脑 spike（1 周）**
新仓库初始化（迁移上表资产 + CI 三平台）；ADR-001 记录转向决策全链；AI SDK spike：DeepSeek + Anthropic 两个 API key profile，挂 bb-browser MCP 调一个真实站点适配器走通 loop，事件进现有 Chat UI，risk-gate 审批钩子生效。
**验收**：干净环境纯 API key 完成一次含工具调用的对话并持久化回放；deny 生效且 audit_log 有记录；CI 绿。
**Kill criteria**：AI SDK 打包/审批钩子问题 1 周未解 → 切 pi-agent-core，M0 延长 1 周。

**M1 · agent-core 正式版 + 工具层（2 周）**
agent-core 迁 utilityProcess（checkpoint/预算硬顶/截断+摘要）；model-providers ≥3 家 + Settings Profile 页；tool-host + MCP client 正式版；连接器规范 v1。
**验收**：会话中途切 provider 续跑；杀进程会话可恢复；会话页可见 token 消耗与金额；外部 MCP server 挂载可调用。

**M2 · 选品场景（2–3 周，dogfooding 节点 1，关键闸门）**
**新写 1688 站点适配器**（照 bb-sites SKILL.md 规范，贡献上游 = 社区生态第一个真实动作）；sourcing-scout skill（搜索→详情补齐→web search 供应商背调→比价表）；对比表卡片 + CSV 导出；结果落知识库。数据三级链：bb-browser 适配器为主 → Playwright 兜底 → 第三方付费 API 留接口不实现。
**验收**：发起人对真实想采的品完成完整选品——≥10 候选对比表（价格带/MOQ/店铺/风险信号/链接）+ ≥3 家背调摘要，据此**真实联系至少 1 家**；次日可对知识库追问；单次会话成本 <¥5 且可见。
**诚实闸门**：一周内发起人自愿使用 ≥3 次——宁愿手动翻 1688 就停下改方向，不堆功能。
**Kill criteria**：站点改版致适配器失效且修复超一周 → 降级"浏览器辅助调研"模式，不硬啃。

**M3 · listing 场景（2 周，dogfooding 节点 2）**
listing-writer skill（中→英重写非直译 + SEO + Amazon/Shopify/TikTok 三平台模板，注入发起人外贸经验）；可编辑草稿面板（分块复制 + 按块让 agent 重写——把生成质量问题转化为交互问题）；知识库闭环：M2 选到的品直接喂 listing。
**验收**：发起人为真实商品生成 listing，≤2 轮编辑达到"可直接贴后台"，并真实粘贴到至少一个平台。

**M4 · Shopify 直发闭环（1–2 周，dogfooding 节点 3）**
shopify-admin 连接器（token 自动刷新）；publish_listing 停 Risk Gate（审批卡片展示完整 payload）。
**验收**：知识库选品 → 生成 listing → 审批确认 → 直发发起人自己的 Shopify 店铺，audit_log 完整；拔掉凭证降级纯粘贴无报错。

**M5 · DIY 面 + 0.2.0 公开发布（2 周）**
skill git URL/本地目录安装 + 热重载开发模式 + **"让 agent 写 skill" meta-skill** + 静态 registry（JSON index，PR 即上架）+ 文档；SubscriptionBackend 实验 flag 放出；三平台安装包（打包配置可从旧仓库分支摘取）；README/定位重写（本地优先、数据归用户、跨平台中立）。
**验收**：一名非发起人外部用户从 Release 安装，30 分钟内跑通对话；外部开发者（或发起人新机器只看文档模拟）1 小时内写出新 skill 跑通，不改核心代码；订阅开关关闭时产品功能完整。

## 风险与应对（top 5）

1. **单人二次烂尾（概率最高）**：里程碑 ≤3 周且各自独立可发布——任何点停下项目仍"可用"而非半成品；M0–M2 冻结 backlog，判据唯一："发起人这周用不用得上"
2. **bb-browser/适配器依赖**：MIT 可 fork；站点改版修 adapter 是社区生态的日常而非灾难（且正是 DIY 用户能参与的事）；Playwright 兜底常备
3. **订阅政策继续摇摆**：结构性隔离为实验 flag，关掉不影响任何功能，风险敞口 ≈0
4. **AI SDK 6 演进/审批钩子表达力**：M0 spike 前置验证 + 接口隔离在 agent-core 包内 + pi-agent-core 逃生门 + 版本锁定
5. **listing 质量命门**：验收即"发起人真实可发布"；草稿面板按块重写兜底

## 不做清单

多 agent 编排 / 自主规划器 / 向量记忆 / RAG；应用内 skill 商店 UI 与沙箱（skill 纯声明式，带代码需求走 MCP）；Amazon SP-API、TikTok 直发（M6+ 梯度点亮）；自建爬虫基础设施与任何反爬对抗；云端服务/账号体系/遥测；零代码人群向导式 UX；OpenClaw 式 gateway/多设备/web 端。

## 验证方式

每个里程碑的验收即验证（见上），共性要求：全部在发起人真机 + 真实业务数据上执行；M2/M3/M4 三个 dogfooding 节点必须产生真实业务动作（联系供应商 / 粘贴 listing / 直发店铺）才算过；audit_log 与 usage 计量作为每次验收的旁证。

## 执行说明

- 本计划批准后：第一步是创建新仓库（名字待发起人定，可沿用 OpenTrad 品牌）、按"资产迁移"表搬运、写 ADR-001，然后进入 M0
- 评审全文与三份独立架构方案、四组事实核查结论存于本会话工作流产物（judge-report.md），新仓库建立后应把定位书 v2 + 本计划以设计文档形式入库
