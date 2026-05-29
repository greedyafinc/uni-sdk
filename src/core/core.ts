import type { CacheConfig } from "./_internal/cache";
import type { RetryAttempt, RetryConfig, RetryListener } from "./_internal/retry";
import { UnifiedError } from "./errors";

export type TokenProvider = string | (() => string | Promise<string>);

export type { CacheConfig } from "./_internal/cache";
export type { RetryAttempt, RetryConfig, RetryListener } from "./_internal/retry";

/**
 * Progress event fired during a multipart upload. `loaded` and `total` are
 * byte counts; `percent` is `0..100` (integer, rounded down). When the body
 * size is unknown ahead of time `total` is `0` and `percent` stays at `0`.
 */
export interface UploadProgressEvent {
  loaded: number;
  total: number;
  percent: number;
}

export type UploadProgressListener = (event: UploadProgressEvent) => void;

export interface CoreOptions {
  /**
   * Trusted-token mode. When set, the SDK bypasses OAuth/PKCE/handoff/keychain
   * and uses the supplied bearer token for every request. Pass a function to
   * have the host resolve a fresh token per request (e.g. read from an auth
   * store). On 401, the SDK re-invokes the provider once to give the host a
   * chance to refresh; if the retry still 401s, the call fails.
   *
   * Intended for first-party apps that already manage their own auth lifecycle.
   * External integrations should leave this unset and use the OAuth flow.
   */
  token?: TokenProvider;
  apiUrl?: string;
  workspaceId?: string;
  appId?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Retry policy for transient failures (429, 5xx, network errors). Pass
   * `false` to disable, an object to override individual fields, or leave
   * unset to use the defaults (3 retries, exponential backoff with jitter,
   * 60s elapsed cap). Honored by `request`, `requestBinary`, and `stream`.
   * Per-call overrides are available via `RequestOptions.retry`.
   *
   * 401-with-refresh is handled separately and is NOT counted against the
   * retry budget — it's an authentication concern, not a transient failure.
   */
  retry?: false | Partial<RetryConfig>;
  /**
   * Fires on every retry attempt with the failing reason and computed delay.
   * Use for telemetry / debug logging — host visibility into when the SDK
   * is papering over transient failures.
   */
  onRetry?: RetryListener;
  /**
   * Opt-in in-memory response cache. When enabled, resources that support
   * caching (embeddings, image generations) can pass `cache: true` on the
   * call to short-circuit identical repeat requests. Initial scope is
   * deterministic-ish endpoints; other resources ignore the option.
   */
  cache?: false | Partial<CacheConfig>;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /**
   * Allowlist of acceptable response Content-Type values for `requestBinary`.
   * Matches by exact MIME (e.g. "video/mp4") or by `<type>/` prefix (e.g.
   * "audio/" matches any audio/* subtype). When set, a 200 with a
   * content-type outside this list is rejected with a `UnifiedAIError`
   * instead of being silently returned as bytes — defense against gateway
   * error pages and provider misconfiguration. Ignored by `request`/`stream`.
   */
  acceptedContentTypes?: readonly string[];
  /**
   * Fires byte-level progress while the request body is being uploaded. Only
   * honored when `body` is a `FormData` instance — JSON requests are too small
   * to be worth instrumenting. The listener receives a synthetic 0/total event
   * before bytes flow and a final total/total event once the body is fully
   * sent. On runtimes without streaming-upload support (no `duplex: "half"`
   * or no `ReadableStream` body), only the synthetic 0/total and total/total
   * events are emitted.
   */
  onUploadProgress?: UploadProgressListener;
  /**
   * Explicit Content-Type override. Used when `body` is a raw byte container
   * (`ArrayBuffer` / `Uint8Array` / `Blob`) and the default JSON encoding is
   * not what's wanted — e.g. chunk PUTs in the resumable-upload protocol
   * send `application/octet-stream`. Ignored for `FormData` (fetch picks the
   * boundary-tagged multipart type itself) and JSON bodies.
   */
  contentType?: string;
  /**
   * Per-call retry override. `false` disables retry for this call; an object
   * overrides individual config fields. Falls back to the client-level setting.
   */
  retry?: false | Partial<RetryConfig>;
  /**
   * Treat this call as idempotent for retry classification. POST/PATCH are
   * not retried on network errors by default (the SDK can't tell if the
   * server processed the request). Set `true` when the endpoint is known to
   * be safe to repeat — e.g. embeddings, image generations, or any GET-like
   * POST.
   */
  idempotent?: boolean;
  /**
   * Per-call retry listener. Fires in addition to the client-level `onRetry`.
   */
  onRetry?: RetryListener;
  /**
   * When `true` and the client was constructed with `cache` enabled, look up
   * the cache before sending and store the result on success. Quietly ignored
   * if the client has no cache configured.
   */
  cache?: boolean;
}

export class Core {
  protected readonly options: Readonly<
    Required<Omit<CoreOptions, "token" | "retry" | "cache" | "onRetry">>
  > & {
    token: TokenProvider | undefined;
    retry: CoreOptions["retry"];
    cache: CoreOptions["cache"];
    onRetry: RetryListener | undefined;
  };

  constructor(options: CoreOptions = {}) {
    this.options = Object.freeze({
      token: options.token,
      apiUrl: options.apiUrl ?? "",
      workspaceId: options.workspaceId ?? "",
      appId: options.appId ?? "",
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
      retry: options.retry,
      cache: options.cache,
      onRetry: options.onRetry,
    });
  }

  async request<T>(_path: string, _options: RequestOptions = {}): Promise<T> {
    throw new UnifiedError("not_implemented", "Core.request is not wired up yet");
  }

  async requestBinary(
    _path: string,
    _options: RequestOptions = {},
  ): Promise<{
    bytes: ArrayBuffer;
    contentType: string;
    headers: Readonly<Record<string, string>>;
  }> {
    throw new UnifiedError("not_implemented", "Core.requestBinary is not wired up yet");
  }

  async stream(_path: string, _options: RequestOptions = {}): Promise<ReadableStream<Uint8Array>> {
    throw new UnifiedError("not_implemented", "Core.stream is not wired up yet");
  }
}
