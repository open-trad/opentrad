export type RuntimeQuarantinedOperation = "stream" | "interrupt";

export class RuntimeOperationQuarantinedError extends Error {
  readonly code = "RUNTIME_OPERATION_QUARANTINED" as const;
  readonly operation: RuntimeQuarantinedOperation;

  constructor(operation: RuntimeQuarantinedOperation) {
    super("Runtime operation is unavailable while Hermes is quarantined");
    this.name = "RuntimeOperationQuarantinedError";
    this.operation = operation;
  }
}
