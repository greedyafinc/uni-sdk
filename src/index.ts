// Browser-safe entry. Pulls zero `node:*` modules — safe for Vite, Webpack,
// Rollup, esbuild, Workers, Deno, and any browser bundler.
//
// For OAuth flows (PKCE + keychain + handoff + loopback), import from
// "@unifiedai/sdk/node" instead.

export { UnifiedAI } from "./core/client";
export type { UnifiedAIOptions } from "./core/client";
export {
  extractServerMessage,
  formatBody,
  httpErrorMessage,
} from "./core/_internal/http-errors";

export { Core } from "./core/core";
export type { CoreOptions, RequestOptions, TokenProvider } from "./core/core";

export {
  UnifiedError,
  UnifiedAIError,
  UnifiedAIAuthError,
  httpErrorCodeFromStatus,
} from "./core/errors";
export type {
  UnifiedErrorCode,
  UnifiedAIAuthErrorCode,
  UnifiedAIHttpErrorCode,
} from "./core/errors";

export type { Identity } from "./core/identity";

export { UnifiedStream } from "./core/_internal/stream";
export type { StreamUsage, StreamUsageExtractor } from "./core/_internal/stream";
export { parseSSE } from "./core/_internal/sse";

// Resource modules — all browser-safe.
export * from "./resources/chat";
export * from "./resources/messages";
export * from "./resources/models";
export * from "./resources/responses";
export * from "./resources/usage";
export * from "./resources/logos";
