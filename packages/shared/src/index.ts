// @opentrad/shared 入口：统一 re-export 所有跨包共享的类型与 zod schema。
// 消费方示例：`import { CCEvent, SkillManifest } from '@opentrad/shared';`
//
// 类型分层（按发起人拍板 D1 = 方案 B'）：
// - domain 类型（本文件根级 export）：OpenTrad 内部统一消费形态，字段 camelCase
// - wire 类型（./types/wire/* export，带 Wire 前缀）：CC 原始事件保真，仅 stream-parser 内部使用

export * from "./channels";
export * from "./types/cc-event";
export * from "./types/cc-task";
export * from "./types/db";
export * from "./types/installer";
export * from "./types/ipc";
export * from "./types/ipc-bridge";
export * from "./types/pty";
export * from "./types/risk-gate";
export * from "./types/skill";
export * from "./types/wire/cc-event";
