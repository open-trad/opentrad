// @opentrad/stream-parser 入口：导出 StreamParser 类、normalize 函数、兼容矩阵工具。
// 对应 03-architecture.md §4.2。

export type { CompatStatus } from "./compat";
export { BASELINE_VERSION, checkCompatibility } from "./compat";
export { normalizeWireEvent } from "./normalize";
export type { StreamParseOptions } from "./parser";
export { StreamParser } from "./parser";
