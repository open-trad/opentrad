# OpenTrad 重启方案 · 三方评审合成报告

## 一、三方共识（无需裁决，直接进最终方案）

三份方案独立得出以下一致结论，置信度高，全部采纳：

1. **Runtime 选型一致**：自建 agent loop 基于 **Vercel AI SDK 6 的 ToolLoopAgent**，以 **pi-agent-core 为逃生门备选**。理由三方雷同：内建循环 + 工具审批钩子（`needsApproval`）与 risk-gate 天然对齐、`@ai-sdk/mcp` 已 stable、多 provider 一等公民、够轻可嵌 Electron。Mastra（偏 server、MCP auth experimental）与 LangGraph.js（TS 二等公民）三方一致排除。
2. **cc-adapter 不退役，降级为订阅后端**——三方对任务简报"cc-adapter 退役"的同一处修正，且均援引 oauth-policy 核实结论：官方 Claude Code/Agent SDK 进程路径是订阅复用唯一合规通道，841 行带测试的现成实现删掉是负价值。定位：实现统一 ChatBackend 接口的 `SubscriptionBackend`，feature-flag + UI 标注"实验性，随 Anthropic 政策可能失效"。
3. **API key 是根基通道**：Anthropic/OpenAI 走官方 `@ai-sdk` 包，DeepSeek/通义/Moonshot 统一走 `@ai-sdk/openai-compatible`；凭证一律存 Electron safeStorage（OS keychain），SQLite 只存引用。借 OpenClaw 的 **auth-profiles 思想**（profile = provider + 凭证 + 模型偏好），不借其 gateway 体重。
4. **risk-gate 零改动复用**：260 行纯逻辑注入式设计挂到工具执行前 / needsApproval 钩子，SQLite RuleProvider/AuditLogger 与 IPC 弹窗 UserPrompter 原样保留，stopBefore 业务级语义落在连接器工具的 manifest 声明上。
5. **连接器层可插拔 + BYO credentials**：任何数据源不焊进 runtime。1688 数据三级链：第三方 API（Apify/万邦 onebound，用户自带 key）为主路径，本机 Playwright + 用户登录态低频兜底，官方 open.1688.com adapter 只留接口给有企业资质用户。
6. **listing MVP 默认"生成 → 人工粘贴"**，API 直发按门槛梯度 Shopify（零审核）→ TikTok → Amazon 渐进点亮；发布动作强制停 Risk Gate 确认。
7. **desktop 壳整体保留**：Chat UI + Markdown + 历史回放、SQLite 六表、Settings、安装向导框架；改造点集中在 IPC 接线（cc.ts → agent.ts）与 Settings 新增 Profile/凭证页。
8. **skill-runtime 保留并扩展 manifest**：YAML + zod + mustache 不动，新增依赖声明字段（connectors/tools/requires）；用户 skill 目录热加载是 DIY 属性地基。
9. **先合并 PR #51/#52**（95% 完成度的 CI 全绿资产）。
10. **放弃 OpenClaw 整机借鉴**（gateway/多 channel/400MB 常驻），单机桌面用 Electron IPC 足够。
11. **MVP 不做**：向量记忆、多 agent 编排、自主规划器、云端服务；trade-email-writer 资产保留但不占 MVP 预算。
12. **发起人 dogfooding 是唯一北极星**，验收绑定可观察的真实业务行为而非 demo。

## 二、分歧点裁决

| # | 分歧 | 方案立场 | 裁决与理由 |
|---|------|---------|-----------|
| 1 | **agent loop 运行位置** | 方案1/2：utilityProcess；方案3：主进程起步 | **utilityProcess 为目标形态**，但允许 M0 spike 先在主进程验证 AI SDK 打包兼容性，M1 迁入。崩溃隔离 + 不阻塞 IPC 的收益明确，迁移成本前置最低。 |
| 2 | **MVP 场景先后** | 方案1：listing 先（零外部依赖）；方案2/3：选品先 | **默认 listing 先**：第一个 dogfooding 节点不应押在灰色第三方 API 的开通/质量上，listing 只依赖用户自己的数据，2 周内可交付真实价值；选品紧随其后。两个里程碑相互独立、可对调——最终顺序留给发起人（见第四节开放决策 1）。 |
| 3 | **apps/mcp-server 去留** | 方案1：工具迁移+封存；方案2：退役；方案3：保留继续挂 | **采方案1/2**：browser-tools 进程内直挂 agent-core，mcp-server 骨架封存不删。新架构里 agent-core 自己是 MCP *client*，给自己开 stdio server 是绕远路；将来要"对外暴露 OpenTrad 能力"再复活。 |
| 4 | **本地贸易知识库**（方案2 独有） | 方案2：products/suppliers/listings/price_quotes 扩表；方案1/3：未提/明确不做跨会话记忆 | **采纳轻量版**：SQLite 结构化扩表（非向量库），M-选品的结果落库、M-listing 可从库中取产品——两场景在数据处闭环，是低成本高价值的差异化资产。侧栏"产品库"浏览 UI 推迟到 M4。它与"不做记忆系统"不矛盾：这是精确结构化查询，不是语义记忆。 |
| 5 | **成本控制内建**（方案3 独有） | 方案3：每会话 token 计量 + 预算硬顶 + usage_log 表 | **采纳**。AI SDK 每步返回 usage，落库成本极低；对"用 API key 而非订阅"的用户是信任基础，也是 dogfooding 验收项（单次会话成本可见）。 |
| 6 | **skill 市场形态与时点** | 方案1：M4 GitHub index + 应用内浏览安装；方案2：静态 registry + git 安装 + "agent 写 skill" meta-skill；方案3：不做市场，只做目录+文档 | **取中**：MVP 尾巴（M4）做 **git URL/本地目录安装 + 热重载开发模式 + 文档 + 静态 JSON index 仓库**（约 3 天量级），**不做应用内商店 UI**。**采纳方案2 的 meta-skill**（"对话让 agent 给你写 skill"）——对"会 vibe coding 的商家"是最锋利的 DIY 卖点，且几乎免费（就是一个 skill）。 |
| 7 | **skill 是否可含代码**（方案2 显式裁决） | 方案2：skill = 纯声明式数据（manifest+prompt），零沙箱可分发；带代码扩展只有连接器一种形态 | **采纳为规范级裁决**。这是能开放分发的前提，把沙箱工程推迟到真有需求时。用户要带代码的能力就挂 MCP server（自己的信任决定）。 |
| 8 | **里程碑节奏纪律** | 方案1：8 周激进；方案2/3：11–13 周 + 方案3 的 kill criteria | **采方案3 的纪律、方案1 的紧凑度**：总计约 9–11 周，每个里程碑 ≤3 周、独立可发布、关键里程碑带 kill criteria。上次 4 天冲刺后停摆的教训是"里程碑必须小到一次生活干扰击不穿"，这条纪律比乐观排期重要。 |
| 9 | **PTY/xterm** | 方案1：保留可见；方案3：入口隐藏 | 保留代码，入口收进"开发者"区域。目标用户会用得上，但不该出现在主流程。 |
| 10 | **listing 输出交互形态** | 方案1：分平台 tab + 复制分区；方案2：可编辑草稿面板 + 按块重写 | **采方案2 的"草稿面板 + 按块让 agent 重写"**，它把"一次生成不完美"从质量问题转化为交互问题，是 listing 场景的质量兜底机制；分平台 tab 与一键复制并入该面板。 |

## 三、推荐方案（合成版）

### 3.1 架构（模块级，延续 pnpm monorepo）

**新增 4 个包：**

- **`packages/agent-core`**（核心，硬约束 <2,500 行）：基于 AI SDK 6 ToolLoopAgent 封装 `AgentSession`——会话生命周期、工具调度、`stopWhen` 步数上限、统一 **AgentEvent 事件流**（泛化 shared/types/cc-event.ts 为 provider 无关 schema，让 desktop 的 events 表持久化与历史回放改动最小）。上下文管理刻意做笨：滑动窗口截断 + 超阈值单次摘要。每步 usage 计量落 `usage_log` 表 + 用户可设会话预算硬顶。每步后 checkpoint 到 SQLite，崩溃可续。运行在 Electron **utilityProcess**。AI SDK 被封在包内部，对外只暴露自己的接口——这既是升级隔离，也是换 pi-agent-core 的逃生门。
- **`packages/model-providers`**：ProviderProfile（`{ id, kind: api-key | subscription, provider, model, credentialRef }`）+ 统一 ChatBackend 接口。`ApiKeyBackend`（默认）：官方 @ai-sdk 包 + openai-compatible 一份代码接 DeepSeek/通义/Moonshot；`SubscriptionBackend`（可选、实验 flag）：**cc-adapter + stream-parser 降级收编于此**，事件转 AgentEvent。
- **`packages/tool-host`**：三类工具统一挂载——内建工具（web fetch/search、文件、**browser-tools 进程内直挂**）、连接器工具、**MCP client**（用户可挂任意 stdio/HTTP MCP server——这是 day-1 就有的 DIY 主通道）。每个工具带 riskLevel + businessAction 元数据，调用前统一过 risk-gate。
- **`packages/connectors`** + 连接器规范 v1：zod manifest 声明 auth 类型、动作列表、每动作 riskLevel/stopBefore；用户自带凭证。MVP 实现：`sourcing-1688`（Apify/onebound 双 adapter 归一到统一 Product/Supplier schema + playwright-local 兜底）、`shopify-admin`（含 24h token 自动刷新）。

**改造：** `skill-runtime`/SkillManifest → Skill 规范 v2（新增 `requires` 依赖声明、`outputs` 结构化 schema 用于落知识库；**skill = 纯声明式数据，不含代码**）；desktop 主进程 IPC 换接线 + Settings 增 Profile/凭证管理页；SQLite 扩贸易知识库表（products/suppliers/listings/price_quotes）+ usage_log。

**复用（零改动或近零）：** risk-gate、browser-tools、Chat UI + 回放、SQLite 六表、skills 表单生成。

**退役/封存：** apps/mcp-server（封存）、cc-detect-loop/安装向导的 Claude Code 检测部分（仅订阅通道启用时按需引导）、PTY 入口隐藏。

**数据流一句话**：Chat 输入 → IPC → agent-core（utilityProcess）建 AgentSession（skill systemPrompt + allowedTools 过滤 + 选定 Profile）→ ToolLoopAgent 循环 → 每次工具调用先过 risk-gate.check()（review 弹窗 / stopBefore 强制停）→ AgentEvent 流回 renderer 渲染并落库 → 回放沿用现有机制，结构化 outputs 落知识库。

### 3.2 Runtime 技术选型

**Vercel AI SDK 6（ToolLoopAgent + @ai-sdk/mcp + provider 生态）**，锁版本，封装在 agent-core 内。M0 第一周做 spike 验证两件事：(a) Electron 打包兼容；(b) needsApproval 能承载 allow_once/allow_always/deny+参数改写全语义。**任一失败 → 切 pi-agent-core**（MIT、OpenClaw 实证可嵌入），切换成本被 agent-core 接口隔离锁死在一个包内。

### 3.3 里程碑（约 9–11 周，每个 ≤3 周、独立可发布）

**M0 · 复活 + 换脑 spike（1 周）**
合并 #52 → #51；写 ADR-001 记录转向（cc-adapter 降级、mcp-server 封存、runtime 选型）；AI SDK spike：接 DeepSeek + Anthropic 两个 API key profile，带一个真工具（browser-tools 页面抓取）走通 loop，事件进现有 Chat UI，risk-gate 挂上审批钩子。
**验收**：干净环境（未装 Claude Code）纯 API key 完成一次含工具调用的对话并持久化；review 级工具弹窗、deny 生效、audit_log 有记录；CI 三平台绿。**Kill criteria**：AI SDK 兼容问题 1 周未解 → 切 pi-agent-core，M0 延长 1 周。

**M1 · agent-core 正式版 + listing 场景（2–3 周，dogfooding 节点 1）**
agent-core 迁 utilityProcess（会话/checkpoint/预算硬顶/截断+摘要）；model-providers ≥3 家 + Settings Profile 页；`listing-writer` skill（中→英本地化 + SEO + Amazon/Shopify/TikTok 三平台模板，注入发起人外贸文案经验，复制 trade-email-writer 模式）；可编辑草稿面板（分块复制 + 按块让 agent 重写）。
**验收**：发起人为一个真实商品生成 listing，≤2 轮编辑达到他自评"可直接贴后台（至多小改）"，并**真实粘贴到至少一个平台**；会话中途切 provider 续跑；杀进程后会话可恢复；会话页可见 token 消耗与金额。

**M2 · 选品场景 + 连接器规范（2–3 周，dogfooding 节点 2，关键闸门）**
tool-host + MCP client；连接器规范 v1 + sourcing-1688（Apify/onebound 至少一家跑通，双实现位 + playwright 兜底）；`sourcing-scout` skill（搜索→详情补齐→web search 供应商背调→比价表）；知识库表落库；对比表卡片 + CSV 导出。
**验收**：发起人对**真实想采的品**完成一次完整选品——≥10 个候选的对比表（价格带/MOQ/店铺年限/风险信号/链接）+ ≥3 家背调摘要，据此**真实联系至少 1 家**；结果落知识库次日可追问；外部 MCP server 挂载可调用；单次会话总成本 <¥5 且界面可见。**诚实闸门**：一周内发起人自愿使用 ≥3 次——如果他宁愿手动翻 1688，停下来改方向而不是继续堆功能。**Kill criteria**：第三方 API 数据质量不可用且兜底维护失控 → 场景降级为"浏览器辅助调研"（agent 驱动用户浏览器 + 摘要），不硬啃反爬。

**M3 · Shopify 直发 + 场景闭环（1–2 周，dogfooding 节点 3）**
shopify-admin 连接器（token 自动刷新）；publish_listing 停 Risk Gate（审批卡片展示完整 payload/diff）；知识库闭环打磨（选品产出直接喂 listing skill）。
**验收**：发起人从知识库选一个 M2 找到的品 → 生成 listing → 审批卡片确认 → 直发到自己 Shopify 店铺，audit_log 完整；拔掉凭证降级为纯粘贴路径无报错。

**M4 · DIY 面 + 0.2.0 公开发布（2 周）**
skill git URL/本地目录安装 + 开发模式热重载 + "让 agent 写 skill" meta-skill + 静态 registry 仓库（JSON index，PR 即上架）+ Skill v2/连接器/MCP 接入文档；trade-email-writer 迁 v2 作规范参考实现；SubscriptionBackend 实验 flag 放出；#51 产物出三平台安装包；README/定位重写（含"本地优先、数据归用户、跨平台中立"第一屏叙事）。
**验收**：一名**非发起人的外部用户**从 Release 下载安装，30 分钟内（含填 API key）跑通 listing 对话；一名外部开发者（找不到就发起人用新机器只看文档模拟）1 小时内写出一个新 skill 并跑通，不改核心代码；meta-skill 生成的 skill 通过 manifest 校验可执行；订阅开关关闭时产品功能完整。

### 3.4 MVP 两场景实现路径

**场景 B · 上架/listing（M1 先行）**
- 数据来源：用户自己的中文产品资料（表单/聊天/粘贴），或给 1688 URL 由 browser-tools 抓详情；M2 后可直接从知识库取。零平台 API 依赖。
- agent 流程：中→英本地化（重写非直译，注入发起人经验）→ SEO 关键词 → 平台合规自检（字符限制/违禁词/五点结构 vs Shopify handle/tags vs TikTok 短文案）→ 结构化 JSON 输出。
- 用户所见：分平台草稿面板，每块（标题/五点/描述/关键词）可复制、可单独让 agent 重写；默认粘贴到后台，M3 起 Shopify 可"直接发布"——停 Risk Gate 审批后才调 Admin API。

**场景 A · 选品/供应商（M2）**
- 数据来源三级链：第三方 API 主路径（用户自带 Apify/万邦 key，BYO 划清灰色地带责任）→ 本机 Playwright + 用户登录态低频兜底（UI 明示脆弱）→ 官方 API adapter 留接口不实现。
- agent 流程：用户给品类 + 目标价 + MOQ 约束 → searchProducts（可多轮换词）→ top 候选 getProductDetail → 归一 zod schema → web search 背调（给线索链接而非结论）→ 比价表 + 推荐理由 → 结构化落知识库。全程只读不触发审批。
- 用户所见：工具调用过程透明可见 → 可排序比价表卡片（可导出 CSV、可追问"第 3 家再挖深"）→ 会话角落常驻本次花费（LLM + 数据 API 计次）。

**共用底座**：同一会话机制、同一套 Profiles（DeepSeek 跑选品省钱、Claude 跑 listing 保质量——模型可插拔 MVP 即有真实用途）、同一历史回放、同一知识库。

### 3.5 风险清单与应对

1. **单人二次烂尾（概率最高的死法）**：里程碑 ≤3 周且各自独立可发布，任何点停下项目仍"可用"而非半成品；agent-core <2,500 行硬约束；M2 设"自愿使用 ≥3 次"诚实闸门；M0–M2 冻结 backlog，判据唯一——"发起人这周用不用得上"。
2. **1688 第三方 API 灰色地带断供/涨价**：连接器双供应商 + 本机兜底 + kill criteria 降级路径；BYO key 划清合规责任；开源产品不代理不转售数据。
3. **订阅 OAuth 政策继续摇摆（5 个月变 3 次）**：结构性隔离为实验 flag 可选后端，M4 才放出，关掉不影响任何功能；绝不裸拿 OAuth token 调 API；风险敞口 ≈0。
4. **AI SDK 6 快速演进 / 审批钩子表达力不足**：M0 spike 前置验证；接口隔离在 agent-core 包内；pi-agent-core 逃生门；版本锁定、升级作为独立任务。
5. **自建 runtime 四大深坑（记忆/上下文/恢复/成本）**：各给最笨可行解——不做跨会话语义记忆、截断+单次摘要、SQLite checkpoint + 工具错误喂回模型自愈、预算硬顶 + usage 落库。
6. **listing 生成质量不达标（MVP 质量命门）**：验收即"发起人真实可发布"；注入真实外贸经验 prompt；草稿面板按块重写把质量问题转化为交互问题。
7. **Electron 工程坑（阻塞/崩溃/密钥）**：utilityProcess 隔离 + 崩溃自动重启（状态在 SQLite）；凭证 safeStorage 不进明文——M0/M1 验收项而非事后补。
8. **Accio 降维打击**：不在数据规模上竞争（必输）；差异化立足 Accio 结构性做不了的：本地优先 + 数据归用户、跨平台中立（非阿里系绑定）、可 DIY 可审计开源。写进 README 第一屏。
9. **生态冷启动**：生态投入压到最便宜形态（静态 index + git 安装约 3 天）；meta-skill 把贡献门槛降到对话级；接受最坏情况——只有发起人一个用户时，项目仍是有价值的自用工具。

### 3.6 不做清单（明确刻意放弃/推迟）

- OpenClaw 式 WebSocket gateway / 多设备 / 多 channel / web 端（M6+ 再议）
- 订阅 OAuth 作为主通道（永远是可选优化项）
- Amazon SP-API、TikTok 直发（M5+ 按门槛梯度点亮）
- 应用内 skill 商店 UI、评分/付费/签名、带代码扩展的沙箱（等真有人要发连接器再做）
- 向量记忆 / RAG / 多 agent 编排 / 自主规划器 / 定时巡检 / 团队协作
- 自建 1688 爬虫基础设施（反爬对抗是别人的主业）
- 云端服务（托管 registry/账号体系/遥测后台）；AGPL-3.0 不变
- 零代码人群的向导式 UX 打磨（与新用户画像自洽地省掉）
- 邮件场景迭代（trade-email-writer 迁 v2 作参考实现，不占里程碑）

## 四、留给发起人的开放决策点

**决策 1：第一个 dogfooding 场景做 listing 还是选品？（决定 M1/M2 顺序）**
这不是工程问题——两个里程碑技术上相互独立可对调，真正的变量是**你自己的业务下周更痛哪个**。
- 选项 A（listing 先，本方案默认）：零外部依赖，2 周内拿到第一次真实价值交付，最大化"重启动能"；代价是更核心的选品痛点晚 3 周。
- 选项 B（选品先）：直击更高价值痛点，且知识库闭环顺序更自然（先有货再写 listing）；代价是第一个验收点押在灰色第三方 API 的开通速度与数据质量上，若 M2 的 kill criteria 触发，项目开局就是一次降级。
- **我的倾向：A**。对有停摆史的单人项目，第一个闭环的确定性比价值密度重要；但如果你未来一个月的真实业务重心就是找货，选 B——dogfooding 的前提是你真的在用。

**决策 2：选品数据的默认姿态——付费第三方 API 主路径，还是浏览器辅助为主？**
这是合规姿态与产品叙事的取舍，不是我能替你做的。
- 选项 A（第三方 API 为默认，本方案倾向）：体验好、数据全、agent 全自动；代价是每次查询有边际成本（约 ¥0.04–0.09/次 + LLM 费），且产品公开文档必须直面"默认路径依赖灰色抓取服务、用户自带 key 自担 ToS"——开源仓库 README 里写这句话，你要舒服。
- 选项 B（本机浏览器辅助调研为默认，API 为进阶选项）：合规叙事干净（用户自己的浏览器、自己的登录态、低频人类速度），零边际成本；代价是慢、脆弱、agent 自动化程度大打折扣，"20 分钟拿 10 个候选比价表"的体验可能退化为"半自动摘要工具"。
- **我的倾向：A**，因为目标用户（会开发、自带凭证）能理解责任边界，且 B 已作为兜底和 kill criteria 降级路径存在于架构中——选 A 不排斥 B，选 B 则大概率永远到不了 A 的体验。你作为公开项目发起人对灰色地带的舆论/法律暴露容忍度，是这个决策的真正输入。