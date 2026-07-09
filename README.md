# OpenTrad

**给外贸人的开源 AI Agent 工作台。**
**Local-first, your data, your models, any platform.**

OpenTrad 是一个开源桌面应用：自带 agent 大脑、模型可插拔的外贸 AI 工作台。对话驱动选品、供应商背调、listing 本地化与发布——数据全在本地，凭证全在你手里，平台中立不锁定。

> 🔄 **2026-07 重启**：本仓库是转向后的新代码库（自建 agent runtime）。原"Claude Code 图形宿主"方向的代码与历史完整保留在 [opentrad-legacy](https://github.com/open-trad/opentrad-legacy)。转向决策见 [ADR-001](docs/adr/ADR-001-restart-pivot.md)，完整计划见 [重启计划](docs/design/restart-plan.md)。

## 这是什么

- **自带大脑**：内置 agent loop（会话、工具调用、多步任务），不是任何 CLI 的壳
- **模型可插拔**：API key 接 Anthropic / OpenAI / DeepSeek / 通义 / Moonshot；便宜模型跑选品、强模型跑 listing，一个会话里可切换
- **用你自己的浏览器干活**：经 [bb-browser](https://github.com/epiral/bb-browser) 站点适配器，用你已登录的浏览器会话调站点内部 API 做选品调研——不代管凭证、不对抗反爬
- **Risk Gate**：一切对外副作用动作（发布 listing、发送内容）强制停在确认卡片前，全程审计
- **可 DIY**：skill 是纯声明式资产（对话就能让 agent 帮你写一个）；挂任意 MCP server 扩展能力；连接器规范开放
- **本地优先**：SQLite 本地存储、无云端、无 telemetry、AGPL-3.0

## 谁在用

面向**具备一定开发能力、了解 AI 的外贸/跨境电商从业者**。发起人本人就是外贸商家——每个里程碑用真实业务验收（真实选品、真实联系供应商、真实发布 listing），不做没人用的功能。

## 状态

🚧 M0 进行中（重启奠基 + agent loop spike）。里程碑与验收标准见 [重启计划](docs/design/restart-plan.md)。

## 架构一览

```
apps/desktop              Electron + React 壳：Chat UI、历史回放、SQLite、Settings
packages/agent-core       自建 agent loop（AI SDK 6 封装，<2500 行硬约束）
packages/model-providers  Profile + ChatBackend（API key 根基 / 订阅通道实验）
packages/tool-host        工具统一挂载：内建 / 连接器 / MCP client（bb-browser 由此接入）
packages/connectors       连接器规范 v1（BYO credentials，动作级 riskLevel/stopBefore）
packages/risk-gate        副作用审批引擎（工具级 + 业务级 stopBefore + 审计）
packages/skill-runtime    声明式 skill（YAML manifest + prompt 合成）
packages/browser-tools    Playwright 兜底浏览器工具
packages/cc-adapter       Claude Code 进程适配（订阅通道 SubscriptionBackend 用，实验）
packages/shared           跨包类型与 zod schema（AgentEvent 等）
```

## 许可证

[AGPL-3.0](LICENSE) © 2026 OpenTrad contributors

AGPL 的含义：你可以自由使用、修改、分发 OpenTrad，但任何修改版本必须同样开源。这是为了防止大厂 fork 闭源商用。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。目前处于 BDFL（仁慈独裁者）阶段，核心方向由项目发起人决定。欢迎 issue 和 discussion，PR 请先提 issue 讨论。

---

[![CI](https://github.com/open-trad/opentrad/actions/workflows/ci.yml/badge.svg)](https://github.com/open-trad/opentrad/actions/workflows/ci.yml)
