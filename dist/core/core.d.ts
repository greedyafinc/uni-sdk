import type { MemoryGrantStore } from "../resources/_kv/sharing.js";
import type { FsBackend } from "../resources/fs/types.js";
import type { StorageBackend } from "../resources/storage/types.js";
import type { SnapshotBackend } from "../resources/sync/types.js";
import type { CacheConfig } from "./_internal/cache.js";
import type { RetryConfig, RetryListener } from "./_internal/retry.js";
export type TokenProvider = string | (() => string | Promise<string>);
export type { CacheConfig } from "./_internal/cache.js";
export type { RetryAttempt, RetryConfig, RetryListener } from "./_internal/retry.js";
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
     *
     * `token` and `appId` select between the two auth modes: set `token` for
     * trusted-token mode, or (node entry only) leave it unset and set `appId`
     * for OAuth mode. When both are set, `token` wins for authentication.
     * `appId` still namespaces `sdk.storage` / `sdk.fs` and is sent as
     * `X-Unified-App` on every request (usage attribution).
     *
     * @see appId for OAuth mode.
     */
    token?: TokenProvider;
    apiUrl?: string;
    workspaceId?: string;
    /**
     * OAuth application (client) id. Selects OAuth mode — but only in the node
     * entry (`@unifiedai/sdk/node`), whose client runs the sign-in ladder
     * (keychain → desktop handoff → browser PKCE) on `bootstrap()` or lazily on
     * the first request. The browser entry has no OAuth machinery: there,
     * `appId` never authenticates and a token-less client's requests fail with
     * `not_implemented`.
     *
     * Auth-wise this is mutually exclusive with `token`: supplying `token`
     * puts the client in trusted-token mode and `appId` is not used for auth.
     * It still serves two mode-independent roles — namespacing the
     * app-scoped resources (`sdk.storage`, `sdk.fs`), and stamping
     * `X-Unified-App` on every request so a shared `uapi_` testing key can
     * still attribute `user_activity.app_name` per app. In OAuth mode with no
     * `appId`, the node client falls back to the UNIFIEDAI_CLIENT_ID environment
     * variable and throws `not_bootstrapped` with guidance when neither is
     * present.
     *
     * @see token for trusted-token mode.
     */
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
    /**
     * Client-level default for the `compression` request param on
     * chat/messages/responses (gateway-side deterministic compression of
     * conversation context). Per-request `compression` values override this
     * default — an explicit per-request `false` beats a client default of
     * `true`. When neither is set, the param is omitted from the wire body.
     */
    compression?: boolean;
    /**
     * Storage backend for `sdk.storage` (the app-namespaced store). When unset,
     * a token-configured client uses the server-backed Cloud backend (unified-api
     * → Supabase); with no token and nothing injected, `sdk.storage` reports
     * unavailable (there is no local browser fallback). A host may inject its own
     * backend here. See STORAGE-SPEC.md.
     */
    storage?: StorageBackend;
    /**
     * File-workspace backend for `sdk.fs` (the app-namespaced file tree). When
     * unset, a token-configured client uses the server-backed Cloud backend
     * (unified-api → Supabase); with no token and nothing injected, `sdk.fs`
     * reports unavailable (no local browser fallback). A host may inject its own
     * backend here. See docs/capability-platform.md.
     */
    fs?: FsBackend;
    /**
     * Snapshot backend for `sdk.sync` (the per-workspace sync engine). Host-
     * injected local persistence so a workspace's materialized view survives a
     * reload (stale-while-revalidate). When unset, the engine runs memory-only /
     * online-first — there is deliberately NO browser persistence fallback. See
     * PROTOCOL.md ("Sync").
     */
    sync?: SnapshotBackend;
    /**
     * Caller class used when checking namespace grants locally (MemoryBackend /
     * tests). `"app"` (default) matches `{ type: "app", appId }` grants;
     * `"agent"` matches `{ type: "agent" }` grants. Sent as `x-unified-caller`
     * so unified-api can classify the same way. The server still re-derives
     * caller class from the credential — this is a hint, not a self-declaration.
     */
    callerKind?: "app" | "agent";
    /**
     * In-process grant table for local UnifiedApp / desktop / tests. When set,
     * `sdk.storage.grants` and `sdk.sync.grants` stay local (no grant HTTP).
     * Pass the **same instance** to `MemoryBackend` and `FakeSyncServer` so
     * enforcement matches CRUD. Cloud clients omit this; unified-api is then
     * authoritative. Production deploy is out of scope — this is the local-dev
     * path.
     */
    grantStore?: MemoryGrantStore;
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
export declare class Core {
    protected readonly options: Readonly<Required<Omit<CoreOptions, "token" | "retry" | "cache" | "onRetry" | "compression" | "storage" | "fs" | "sync" | "callerKind" | "grantStore">>> & {
        token: TokenProvider | undefined;
        retry: CoreOptions["retry"];
        cache: CoreOptions["cache"];
        onRetry: RetryListener | undefined;
        compression: boolean | undefined;
        storage: StorageBackend | undefined;
        fs: FsBackend | undefined;
        sync: SnapshotBackend | undefined;
        callerKind: "app" | "agent";
        grantStore: MemoryGrantStore | undefined;
    };
    constructor(options?: CoreOptions);
    /**
     * Client-level `compression` default, readable by resources when merging
     * request bodies (`options` itself is `protected`). `undefined` when the
     * client was constructed without one.
     */
    get defaultCompression(): boolean | undefined;
    /**
     * The app identity used to namespace `sdk.storage`. Set by the host when it
     * constructs a per-app SDK; empty for an unscoped client (storage then falls
     * back to a `"default"` namespace).
     */
    get appId(): string;
    /** The injected storage backend, if any. `undefined` uses the Cloud backend when server-capable, else none. */
    get storageBackend(): StorageBackend | undefined;
    /** The injected fs backend, if any. `undefined` uses the Cloud backend when server-capable, else none. */
    get fsBackend(): FsBackend | undefined;
    /** The injected snapshot backend for `sdk.sync`, if any. `undefined` runs the engine memory-only. */
    get snapshotBackend(): SnapshotBackend | undefined;
    /**
     * Caller class for namespace grants (`"app"` or `"agent"`). Defaults to
     * `"app"`. See {@link CoreOptions.callerKind}.
     */
    get callerKind(): "app" | "agent";
    /**
     * Host-injected in-process grant table, if any. Local UnifiedApp / desktop
     * wires this so grant CRUD never leaves the process. `undefined` means
     * storage falls back to `MemoryBackend.grants` (when that backend is
     * injected) and sync grant CRUD goes over HTTP.
     */
    get grantStore(): MemoryGrantStore | undefined;
    /**
     * Whether the client can reach the server, i.e. it has a token provider
     * (trusted-token mode). When true and no backend is injected, `sdk.storage`
     * and `sdk.fs` use the server-backed Cloud backend (unified-api → Supabase) so
     * app data follows the user across devices. When false (and nothing injected)
     * they are unavailable — there is no local browser fallback. The node OAuth
     * client overrides this to always-true.
     */
    get serverCapable(): boolean;
    request<T>(_path: string, _options?: RequestOptions): Promise<T>;
    requestBinary(_path: string, _options?: RequestOptions): Promise<{
        bytes: ArrayBuffer;
        contentType: string;
        headers: Readonly<Record<string, string>>;
    }>;
    stream(_path: string, _options?: RequestOptions): Promise<ReadableStream<Uint8Array>>;
}
//# sourceMappingURL=core.d.ts.map