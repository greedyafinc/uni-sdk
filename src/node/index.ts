// Node entry. Provides the OAuth-capable UnifiedAI subclass plus everything
// from the browser-safe core. Pulls Node-only modules (`node:http`, `node:fs`,
// `@napi-rs/keyring`) — do not import this from a browser bundle.
//
// Imports are explicit (rather than `export * from "../"`) because Bun's
// bundler silently drops the local UnifiedAI subclass when both a wildcard
// re-export and a named override declare the same symbol.

// Core class — for advanced consumers wiring a custom transport.
export { Core } from "../core/core";
export type {
  CacheConfig,
  CoreOptions,
  RequestOptions,
  RetryAttempt,
  RetryConfig,
  RetryListener,
  TokenProvider,
} from "../core/core";

// Errors.
export {
  UnifiedError,
  UnifiedAIError,
  UnifiedAIAuthError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  RateLimitError,
  UsageLimitError,
  ServerError,
  buildHttpError,
  httpErrorCodeFromStatus,
} from "../core/errors";
export type {
  UnifiedErrorCode,
  UnifiedAIAuthErrorCode,
  UnifiedAIHttpErrorCode,
} from "../core/errors";

// Identity.
export type { Identity } from "../core/identity";

// Session surface.
export { Session } from "../core/session";
export type {
  SessionStatus,
  SessionSnapshot,
  SessionEvent,
  SessionEventType,
  SessionListener,
} from "../core/session";

// Stream + SSE.
export { UnifiedStream } from "../core/_internal/stream";
export type { StreamUsage, StreamUsageExtractor } from "../core/_internal/stream";
export { parseSSE } from "../core/_internal/sse";

// Error helpers.
export {
  extractServerMessage,
  formatBody,
  httpErrorMessage,
} from "../core/_internal/http-errors";

// Resources.
export * from "../resources/audio";
export * from "../resources/chat";
export * from "../resources/embeddings";
export * from "../resources/files";
export * from "../resources/helpers";
export * from "../resources/images";
export * from "../resources/messages";
export * from "../resources/models";
export * from "../resources/responses";
export * from "../resources/usage";
export * from "../resources/videos";
export * from "../resources/logos";

// The node-capable UnifiedAI — supersedes the browser entry's class. Consumers
// importing from this entry get the OAuth-capable client under the same name.
export { UnifiedAI } from "./client";
export type { UnifiedAIOptions } from "./client";

// Node-specific configuration types.
export type { DiscoveryReader } from "./_internal/discovery";
export type { EnvReader } from "./_internal/env";
export type { KeychainAdapter } from "./_internal/keychain";
export type { LoopbackServer, LoopbackHandle, OpenUrl } from "./_internal/browser-auth";
export type { TokenSet } from "../core/_internal/tokens";
