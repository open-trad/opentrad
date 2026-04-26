# 催付场景示例

## 输入

- **scenario**: 催付
- **context**: 越南买家 ABC Trading,30 天前付了 30% 定金 USD 1,500(PO #2025-001 总额 USD 5,000)。提单复印件已发 15 天前,余款 USD 3,500 应在见提单 7 天内付,现在已逾期 8 天。之前邮件未回。语气:firm(已耐心过,该升级)
- **tone**: firm
- **previousEmail**: (空,主动催)

## 期望 prompt 输出(草稿示例)

### Draft 1: 直接强势 + 设硬 deadline

**Subject**: Urgent: Outstanding Balance USD 3,500 — PO #2025-001

**Body**:
Dear [Buyer Name],

This email is a follow-up regarding the outstanding balance for PO #2025-001, which is now 8 days past due.

**Payment summary**:
- Total order value: USD 5,000
- Deposit (30%): USD 1,500 — received [date]
- Balance (70%): USD 3,500 — **8 days overdue**

The B/L copy was sent on [date], and per our agreed terms the balance was due within 7 days of B/L receipt. We have not received your payment or any communication regarding the delay since then.

Please remit USD 3,500 to the bank account previously provided **by [deadline, 7 days from today]**. If there is any issue blocking payment on your end, please reply to this email today so we can discuss a workable solution.

Continued delay will affect our future business with us and our ability to extend credit terms on new orders.

Best regards,
[Your Name]
[Your Company]

---

### Draft 2: 强势但留沟通空间(deadline + 提供方案)

**Subject**: Action Required: Balance Payment for PO #2025-001 (Now 8 Days Overdue)

**Body**:
Dear [Buyer Name],

I am writing regarding the unpaid balance of USD 3,500 for PO #2025-001, which became overdue 8 days ago.

We understand circumstances can delay payment, but we have not received any update from your side since the B/L copy was sent on [date]. Without communication we have no way to plan our cash flow or process any new orders from your side.

We need one of the following from you by **[deadline, 7 days from today]**:
1. Full payment of USD 3,500 to the bank account on file, OR
2. A short reply explaining the delay and a proposed payment date

If we do not hear from you by [deadline], we will need to pause work on any open RFQs from your side and reassess our credit terms going forward.

Best regards,
[Your Name]
[Your Company]

---

### Draft 3: 抄送对方上级 / 财务部门(firm 第三档,首次主动催付的真实最强手段)

**Subject**: Outstanding Balance USD 3,500 — Escalating to Finance Team (PO #2025-001)

**CC**: [Their CFO / Finance Manager email]

**Body**:
Dear [Buyer Name],

Following up on PO #2025-001 — the outstanding balance of USD 3,500 became overdue 8 days ago, and we have not received a response to our prior communications.

**Payment summary**:
- Balance due: USD 3,500
- Overdue: 8 days
- B/L copy sent: [date]

I have copied your finance team on this email to ensure visibility on this matter. If there are processing issues on your side that you have not been able to resolve, your finance colleagues may be able to reply directly.

Please confirm payment by **[deadline, 5 days from today]**, or reply with a specific payment date. Bank details remain as previously provided.

Best regards,
[Your Name]
[Your Company]

---

## Key phrases used

- **8 days past due** / **8 days overdue**:具体天数比 "long overdue" / "very late" 有力。书面催付的数字精确度直接传达"我们在跟进,不是随便说说"
- **per our agreed terms**:引用合约条款,把对话从"求情"变"行权",firm tone 的关键
- **affect our future business with us / extend credit terms on new orders**(Draft 1):商业层面后果(非个人威胁),Western 商业语境标准升级语
- **process any new orders from your side**(Draft 2):自然英语,避免 "your next order" 单数指代不清的 Chinglish 模式
- **I have copied your finance team to ensure visibility**(Draft 3):firm 第三档的核心机制 — 用透明度施压而非威胁。"ensure visibility" 是 Western 公司内部沟通的中性短语,不让对方觉得被"打小报告"

## Risk notes

- **Draft 3 适用条件**:已有 1-2 轮催付未果,且能拿到对方财务 / 上级邮箱。本场景"首次主动催付"严格说应从 Draft 1 / 2 起手,**Draft 3 仅作"如对方持续不回应,7-14 天后第三轮升级"的预备模板**
- **deadline 设置**:首次催付 7-10 天是行业惯例(给买家银行处理 + 跨境支付时间);抄送升级版用 5 天暗示"我已升级,需要快速回应"
- **越南买家文化提示**:面子文化,公开施压(如群发抄送 cc 多人)会加剧抵触。Draft 3 抄送应**只 cc 1 个对方财务 / 上级**,绝不抄送"竞争对手"或"对方客户"
- **建议私下沟通先于群发抄送**:第一次催付前,如有越南本地销售联系人或合作伙伴,用电话或 WhatsApp 私下了解情况,再决定是否走 firm 邮件。直接 firm 邮件而无私下沟通,可能错过"对方真有客观困难"的窗口
- 如 Draft 3 后仍无回应(7-14 天),真要走法律 / collections,**先咨询当地法律**(中越贸易合同管辖权 / 仲裁条款 / CIETAC 等),不要在邮件里 bluff "Final Notice / certified mail / legal action"——99% 是吓自己,Western buyer 看穿后反而会硬扛

发起人:**催付场景看 firm tone 三档(deadline + 后果暗示 / deadline + 提供方案 / deadline + 抄送上级)区别是否清楚、deadline 天数(7/7/5)是否符合外贸催收实践、Draft 3 抄送上级的 "ensure visibility" 透明度施压机制是否合理**。
