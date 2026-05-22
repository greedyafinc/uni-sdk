export type UnifiedErrorCode =
  | "not_implemented"
  | "not_bootstrapped"
  | "app_not_installed"
  | "handoff_unreachable"
  | "auth_user_cancelled"
  | "auth_state_mismatch"
  | "auth_token_exchange_failed"
  | "keychain_unavailable"
  | (string & {});

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
