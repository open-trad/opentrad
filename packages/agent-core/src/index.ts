// @opentrad/agent-core：自建 agent loop（产品的大脑）。
// M0 spike：createAgentSession 基于 AI SDK 6 的 streamText+stopWhen 工具循环实现；
// 本包对外只暴露自己的接口，AI SDK 不出包边界。

export * from "./session";
export * from "./types";
