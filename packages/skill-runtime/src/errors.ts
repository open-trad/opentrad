// SkillLoader / PromptComposer 专用错误。
//
// **ValidationError**:PromptComposer 必填 input 缺失时抛(对齐 03 §4.3 + #23 决策点 D-M1-2)。
// **SkillLoadError**:SkillLoader.loadFromDirectory 内部不抛(改为返回 LoadResult.error),
//   但暴露此类供调用方在自己语境下抛/包裹。

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class SkillLoadError extends Error {
  // Error.cause 走 ES2022 标准(ErrorOptions),不重复声明实例字段,避免与基类 cause 冲突。
  constructor(
    message: string,
    public readonly skillDir: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "SkillLoadError";
  }
}
