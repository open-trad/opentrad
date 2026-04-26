# 报价场景示例

## 输入

- **scenario**: 报价
- **context**: 美国买家 Acme Corp 询 1000 件无线鼠标,要 FOB 深圳价格,需 OEM 包装。我们 MOQ 500 件,我们成本 USD 4.50/件,FOB 5.20 美元/件,T/T 30% 定金 70% 见提单。lead time 25 天。希望同时给量价阶梯吸引大单。
- **tone**: formal
- **previousEmail**: (空,新邮件)

## 期望 prompt 输出(草稿示例)

### Draft 1: 标准报价 + 量价阶梯

**Subject**: Quotation for 1,000 Wireless Mice (OEM, FOB Shenzhen)

**Body**:
Dear Sir / Madam,

Thank you for your inquiry regarding our wireless mouse. Please find our quotation below for the requested quantity, with tier pricing for larger orders.

**Item**: Wireless Mouse, OEM packaging
**Quantity**: 1,000 pcs
**Unit price**: USD 5.20 / pc, FOB Shenzhen
**Total**: USD 5,200.00
**Tier pricing** (for larger orders):
- 2,000 - 4,999 pcs: USD 4.95 / pc
- 5,000 + pcs: USD 4.80 / pc

**Lead time**: 25 working days after deposit received and OEM artwork confirmed
**Payment terms**: 30% T/T deposit, 70% balance against B/L copy
**Validity**: This quotation is valid for 30 days from the date of this email

Please confirm OEM packaging artwork at your earliest convenience so we can include design review in the lead time. Should you need a sample for evaluation, we are happy to ship one DDP at no charge.

We look forward to your feedback.

Best regards,
[Your Name]
[Your Company]

---

### Draft 2: 简洁版(单价 + 关键条款)

**Subject**: Pricing for 1,000 OEM Wireless Mice — FOB Shenzhen USD 5.20

**Body**:
Dear Sir / Madam,

Thank you for your interest in our wireless mouse.

Quotation for 1,000 pcs (OEM packaging):
- USD 5.20 per piece, FOB Shenzhen
- 25-day lead time after deposit + artwork confirmation
- 30% T/T deposit, 70% against B/L copy
- Quote valid 30 days

Should you require alternative quantities or any spec adjustment, please let us know and we will revise accordingly.

Best regards,
[Your Name]
[Your Company]

---

## Key phrases used

- **FOB Shenzhen**:Free On Board 深圳港。明确船上交货,后续海运 / 关税买方承担。美国买家通常熟悉此术语
- **30% T/T deposit, 70% balance against B/L copy**:行业标准付款条款,定金后开工,见提单复印件付尾款。比"100% 预付"对买家友好,比"100% 见提单付"对卖家有保障
- **MOQ**(隐含,因量 1000 > 500 起订未写出):1000 在 MOQ 之上,无需提示
- **Lead time**:25 working days,行业标准节奏。**避免说"around 25 days"含糊**

## Risk notes

- 量价阶梯透露了规模化定价,买家可能借此压价。**对策**:tier pricing 写阶梯条件而非"我们成本能再降",维持议价空间
- 标准条款 70% 见提单可能不被新买家接受(他们可能要求 100% 见提单付)。**对策**:Draft 2 简洁版可作首次接触;Draft 1 含条款适合已有信任基础

发起人:**报价场景看英文是否地道、术语用法、量价阶梯展示节奏是否符合外贸惯例**。
