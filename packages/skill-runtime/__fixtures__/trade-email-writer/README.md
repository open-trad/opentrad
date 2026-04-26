# trade-email-writer — 外贸邮件助手

为外贸出口方生成多版本英文邮件草稿,覆盖 6 种典型场景 × 3 种语气。

## 使用流程

1. 左栏 SkillPicker 选 "外贸邮件助手"
2. 填表:
   - **场景**:报价 / 议价 / 催付 / 催货 / 售后 / 跟进 选一个
   - **上下文**:用中文描述(收件人是谁 / 之前发生什么 / 本次目的)。越具体输出越准
   - **语气**:formal(正式)/ friendly(友好,与熟客)/ firm(坚定,问题升级时)
   - **上一封邮件**(可选):粘贴对方上一封原文 → 触发 reply 模式
3. 点"发送" → CC 生成 2-3 份不同 strategy 角度的草稿
4. 草稿自动保存到 `~/.opentrad/drafts/trade-email-<场景>-<时间>-draft-N.md`
5. Chat UI 渲染 markdown,可直接复制到邮件客户端发送

## 行业术语速查(prompt 已内置常用词)

| 术语 | 全称 | 含义 |
|---|---|---|
| FOB | Free On Board | 港口装船,后续运费风险买方承担 |
| CIF | Cost, Insurance, Freight | 含运费 + 保险价 |
| EXW | Ex Works | 出厂价(买家自取) |
| DDP | Delivered Duty Paid | 完税交货 |
| MOQ | Minimum Order Quantity | 起订量 |
| RFQ | Request for Quotation | 询价 |
| L/C | Letter of Credit | 信用证 |
| T/T | Telegraphic Transfer | 电汇 |
| D/P | Documents against Payment | 付款交单 |
| B/L | Bill of Lading | 提单 |
| FCL / LCL | Full / Less than Container Load | 整 / 拼柜 |
| pro forma | Pro Forma Invoice | 形式发票(报价单) |

## 隐私 / 安全

- 草稿只存本地 `~/.opentrad/drafts/`,**OpenTrad 不上传任何邮件内容**
- `mcp__*__send*` 工具显式 disallowed(不能直接发邮件,需用户复制到邮件客户端)
- riskLevel='draft_only',M1 不需要 RiskGate 业务级弹窗

## 示例

- [报价场景示例](./examples/quotation.md)
- [催付场景示例](./examples/chasing-payment.md)

## prompt 调优

prompt 在 `prompt.md`,M1 第一版可能产出"AI 味"较重的输出。发起人 dev 校时如发现:
- 出现"As an AI assistant"开场白
- 邮件英文不地道(Chinglish 模式)
- 3 语气区别不明显(formal / firm 雷同)
- 行业术语错用(如把 L/C 当 T/T)

→ 直接编辑 `prompt.md` 调整 + 重跑 SkillPicker → 表单 → 看输出对比。retrospective-m1 时记录 prompt 演化历史。
