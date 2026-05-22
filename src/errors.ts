export type UnifiedErrorCode = "not_implemented" | (string & {});

export class UnifiedError extends Error {
  readonly code: UnifiedErrorCode;
  readonly status: number | undefined;

  constructor(code: UnifiedErrorCode, message: string, status?: number) {
    super(message);
    this.name = "UnifiedError";
    this.code = code;
    this.status = status;
  }
}
