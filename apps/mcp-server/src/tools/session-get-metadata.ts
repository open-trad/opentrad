// session_get_metadata tool（M1 #26）：通过 IPC bridge 查 desktop 主进程
// SQLite 里当前 session 的 SessionMeta 视图（id / title / skillId / 时间戳 / status）。
//
// riskLevel = "safe"：read-only。skill 用它做"我现在在哪个 session 里"的自查。
// 不暴露 ccSessionPath / cost / messageCount 等内部字段（SessionMeta 投影已守住）。

import { z } from "zod";
import type { OpenTradTool } from "./index";

const InputSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe("要查询的 session ID。不传时使用当前 task 的 sessionId（OPENTRAD_SESSION_ID env）。"),
});

export const sessionGetMetadataTool: OpenTradTool = {
  name: "session_get_metadata",
  description:
    "Get metadata of an OpenTrad session (id/title/skillId/timestamps/status). Defaults to the current task's session when sessionId is omitted.",
  inputSchema: InputSchema,
  riskLevel: "safe",
  category: "utility",
  async execute(rawInput, { bridge, sessionId: currentSessionId }) {
    const input = InputSchema.parse(rawInput);
    const sessionId = input.sessionId ?? currentSessionId;
    const meta = await bridge.sessionMetadata({ sessionId });
    if (!meta) {
      return [
        {
          type: "text",
          text: `No session found with id ${sessionId}`,
        },
      ];
    }
    const lines = [
      `Session ${meta.id}:`,
      `  title: ${meta.title}`,
      `  skillId: ${meta.skillId ?? "(none)"}`,
      `  status: ${meta.status}`,
      `  createdAt: ${new Date(meta.createdAt).toISOString()}`,
      `  updatedAt: ${new Date(meta.updatedAt).toISOString()}`,
    ];
    return [
      {
        type: "text",
        text: lines.join("\n"),
      },
    ];
  },
};
