// draft_save tool（M1 #26）：把 skill 生成的草稿走 IPC bridge `draft.save` RPC
// 写到 desktop 主进程管理的 ~/.opentrad/drafts/{date}-{filename}.md。
//
// riskLevel = "safe"：M1 范围内不弹窗（draft_only skill 共用约定，03 §4.5）。
// 真实 RiskGate 拦截在 M1 #11 / #28 加 middleware；本工具不主动调
// risk-gate.request RPC（safe 类应该自动 allow，避免冗余 audit 噪音）。

import { z } from "zod";
import type { OpenTradTool } from "./index";

const InputSchema = z.object({
  filename: z.string().min(1).describe("草稿文件名，自动加日期前缀。建议 .md 后缀"),
  content: z.string().describe("草稿正文（markdown）"),
});

export const draftSaveTool: OpenTradTool = {
  name: "draft_save",
  description:
    "Save a draft markdown to the OpenTrad drafts folder. Use this to persist generated content.",
  inputSchema: InputSchema,
  riskLevel: "safe",
  category: "drafts",
  async execute(rawInput, { bridge }) {
    const input = InputSchema.parse(rawInput);
    const result = await bridge.draftSave({
      filename: input.filename,
      content: input.content,
    });
    return [
      {
        type: "text",
        text: `Draft saved to ${result.path}`,
      },
    ];
  },
};
