// hs_code_lookup tool（M1 #26）：HS Code 候选查询。
// **M1 mock**：返回固定 3 个 candidate（从 description 关键词无关，纯演示）。
// **M2 真实化**：接对外 HS Code 数据库（如 wco / 海关总署 / 第三方 API）。
//
// riskLevel = "safe"：read-only 查询，不影响外部状态。

import { z } from "zod";
import type { OpenTradTool } from "./index";

const InputSchema = z.object({
  description: z.string().min(1).describe("商品中英文描述，用于查询候选 HS Code"),
});

interface HsCodeCandidate {
  code: string;
  description: string;
  rationale: string;
}

const MOCK_CANDIDATES: HsCodeCandidate[] = [
  {
    code: "8517.62",
    description: "通信用机器（M1 mock candidate）",
    rationale: "M1 #26 占位返回，真实分类逻辑在 M2 接入海关数据库",
  },
  {
    code: "8542.31",
    description: "处理器及控制器（M1 mock candidate）",
    rationale: "同上",
  },
  {
    code: "9013.80",
    description: "其他光学器件（M1 mock candidate）",
    rationale: "同上",
  },
];

export const hsCodeLookupTool: OpenTradTool = {
  name: "hs_code_lookup",
  description:
    "Look up candidate HS Codes for a product description. M1 returns fixed mock candidates; real lookup lands in M2.",
  inputSchema: InputSchema,
  riskLevel: "safe",
  category: "platform",
  async execute(rawInput) {
    const input = InputSchema.parse(rawInput);
    const lines = [
      `HS Code candidates for "${input.description}" (M1 mock):`,
      "",
      ...MOCK_CANDIDATES.map((c, i) => `${i + 1}. ${c.code} — ${c.description}\n   ${c.rationale}`),
    ];
    return [
      {
        type: "text",
        text: lines.join("\n"),
      },
    ];
  },
};
