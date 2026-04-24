// @opentrad/shared 入口：统一 re-export 所有跨包共享的类型与 zod schema。
// 消费方示例：`import { CCEvent, SkillManifest } from '@opentrad/shared';`

export * from "./types/cc-event";
export * from "./types/cc-task";
export * from "./types/ipc";
export * from "./types/risk-gate";
export * from "./types/skill";
