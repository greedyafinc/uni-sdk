export type UnifiedErrorCode =
  | "not_implemented"
  | "not_bootstrapped"
  | "app_not_installed"
  | "handoff_unreachable"
  | "auth_user_cancelled"
  | "auth_state_mismatch"
  | "auth_token_exchange_failed"
  | "auth_refresh_failed"
  | "auth_retry_still_unauthorized"
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

export type UnifiedAIAuthErrorCode = "auth_refresh_failed" | "auth_retry_still_unauthorized";

export class UnifiedAIAuthError extends UnifiedError {
  constructor(code: UnifiedAIAuthErrorCode, message: string, status?: number) {
    super(code, message, status);
    this.name = "UnifiedAIAuthError";
  }
}

export type UnifiedAIHttpErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "server_error"
  | "request_failed";

export class UnifiedAIError extends UnifiedError {
  readonly body: unknown;

  constructor(code: UnifiedAIHttpErrorCode, message: string, status: number, body: unknown) {
    super(code, message, status);
    this.name = "UnifiedAIError";
    this.body = body;
  }
}

export function httpErrorCodeFromStatus(status: number): UnifiedAIHttpErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 500) return "server_error";
  return "request_failed";
}
