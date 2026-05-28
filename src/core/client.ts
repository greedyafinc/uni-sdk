import { Audio } from "../resources/audio";
import { Chat } from "../resources/chat";
import { Embeddings } from "../resources/embeddings";
import { Files } from "../resources/files";
import { Helpers } from "../resources/helpers";
import { Images } from "../resources/images";
import { Messages } from "../resources/messages";
import { Models } from "../resources/models";
import { Responses } from "../resources/responses";
import { Usage } from "../resources/usage";
import { Videos } from "../resources/videos";
import {
  drainResponse,
  formatBody,
  httpErrorMessage,
  readErrorBody,
} from "./_internal/http-errors";
import { Core, type CoreOptions, type RequestOptions, type UploadProgressListener } from "./core";
import {
  UnifiedAIAuthError,
  UnifiedAIError,
  UnifiedError,
  buildHttpError,
  headersToRecord,
} from "./errors";
import type { Identity } from "./identity";
import { Session } from "./session";

const DEFAULT_API_URL = "https://api.unifiedai.app";

// Browser bundles don't have `process`. Read env vars defensively so importing
// the SDK in a Vite/Workers/edge runtime doesn't throw at construction time.
function envVar(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  return process.env[name];
}

/**
 * Wrap a Blob's stream so each pulled chunk fires a progress event before it
 * reaches the network. Returns a fresh stream every call so the body can be
 * re-sent on a 401 retry — `Blob.stream()` is one-shot per ReadableStream,
 * but the underlying Blob can be re-streamed indefinitely.
 *
 * The listener is invoked from a microtask after `controller.enqueue`; if it
 * throws, the error is swallowed — a buggy host callback must not corrupt the
 * upload mid-flight.
 */
/**
 * Estimate the byte size of a FormData after multipart encoding, WITHOUT
 * materializing it. Walks parts and sums `value.size` (Blob/File) or the
 * UTF-8 encoded length (string parts), plus a generous per-part overhead
 * for boundaries and headers. Pessimistic by design — we use this only
 * to decide whether the actual encoding is safe to do, so over-estimating
 * is fine (we skip wrapping and the host gets coarser progress) but
 * under-estimating would defeat the cap.
 */
function estimateFormDataBytes(form: FormData): number {
  let total = 0;
  let partCount = 0;
  const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : undefined;
  for (const [name, value] of form.entries()) {
    partCount += 1;
    // RFC 7578 encodes the field name into the Content-Disposition header;
    // we approximate its contribution by its UTF-8 byte length. The
    // per-part overhead added below covers the surrounding header bytes
    // (`Content-Disposition: form-data; name="..."` + CRLFs) — the goal is
    // an over-estimate, not an exact match.
    total += encoder ? encoder.encode(name).length : name.length;
    if (typeof value === "string") {
      total += encoder ? encoder.encode(value).length : value.length;
    } else {
      // FormDataEntryValue = string | File; the else branch is a File but
      // tsc's `for...of` narrowing loses that without an explicit cast.
      total += (value as Blob).size;
    }
  }
  // ~200 bytes per part covers boundary + Content-Disposition + Content-Type
  // headers with room to spare. The trailing boundary adds another ~50.
  total += partCount * 200 + 50;
  return total;
}

/**
 * Emit a progress event without letting a throwing listener tear down the
 * upload. Host UI bugs must not abort an otherwise-healthy request.
 */
function safeEmit(
  listener: UploadProgressListener | undefined,
  loaded: number,
  total: number,
): void {
  if (!listener) return;
  try {
    listener({
      loaded,
      total,
      percent: total > 0 ? Math.floor((loaded / total) * 100) : 0,
    });
  } catch {
    // Host listener errors must not abort the upload.
  }
}

function progressStream(
  blob: Blob,
  onProgress: UploadProgressListener,
): ReadableStream<Uint8Array> {
  const total = blob.size;
  const reader = blob.stream().getReader();
  let loaded = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      loaded += value.byteLength;
      controller.enqueue(value);
      safeEmit(onProgress, loaded, total);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/**
 * Options for the browser-safe UnifiedAI client.
 *
 * To use OAuth (PKCE bootstrap, keychain storage, handoff discovery), import
 * from "@unifiedai/sdk/node" instead — that entry exposes a UnifiedAI subclass
 * with the additional `authorizeUrl`, `tokenUrl`, `discovery`, `keychain`,
 * `openUrl`, and `loopback` options.
 */
export interface UnifiedAIOptions extends CoreOptions {}

/**
 * Browser-safe UnifiedAI client. Requires trusted-token mode (a string or
 * async callback supplied via the `token` option). For OAuth flows, see
 * `@unifiedai/sdk/node`.
 *
 * Subclasses extend this base to add bootstrap strategies. The HTTP request
 * and stream paths live here so all auth modes share a single 401-retry flow;
 * mode-specific behavior is reached through `protected` hooks.
 */
export class UnifiedAI extends Core {
  readonly models: Models = new Models(this);
  readonly usage: Usage = new Usage(this);
  readonly chat: Chat = new Chat(this);
  readonly responses: Responses = new Responses(this);
  readonly messages: Messages = new Messages(this);
  readonly images: Images = new Images(this);
  readonly files: Files = new Files(this);
  readonly audio: Audio = new Audio(this);
  readonly videos: Videos = new Videos(this);
  readonly embeddings: Embeddings = new Embeddings(this);
  readonly helpers: Helpers = new Helpers();

  /**
   * Observable auth-session surface: `isAuthenticated()`, `expiresAt`,
   * `identity`, and `onChange(listener)`. In trusted-token mode it reflects
   * the configured token (active while one is set); the node OAuth subclass
   * additionally tracks expiry, caches identity, and drives proactive refresh.
   */
  readonly session: Session;

  private trustedRefreshPromise: Promise<string> | undefined;

  constructor(options: UnifiedAIOptions = {}) {
    super({
      ...options,
      apiUrl: options.apiUrl ?? envVar("UNIFIEDAI_API_URL") ?? DEFAULT_API_URL,
    });
    // Trusted-token mode is "authenticated" the moment a token is configured —
    // the host owns the lifecycle so the SDK can't see expiry, but it can
    // truthfully report that a session exists. OAuth mode starts signed-out
    // until bootstrap() establishes tokens.
    this.session = new Session(this.options.token !== undefined ? "active" : "signed_out");
  }

  /**
   * In trusted-token mode, bootstrap is a no-op (the host owns the lifecycle).
   * Subclasses override this to run OAuth bootstrap. Calling bootstrap on the
   * base class without a `token` configured throws — those callers should
   * import the node subclass instead.
   */
  bootstrap(): Promise<void> {
    if (this.options.token !== undefined) return Promise.resolve();
    return Promise.reject(
      new UnifiedError(
        "not_implemented",
        "OAuth bootstrap is unavailable in the browser entry. Either pass `token` " +
          "to use trusted-token mode, or import UnifiedAI from '@unifiedai/sdk/node'.",
      ),
    );
  }

  identity(): Identity {
    throw new UnifiedError(
      "not_bootstrapped",
      "identity() requires the node entry or a subclass that owns user-session state.",
    );
  }

  /**
   * No-op in trusted-token mode — the host owns the token lifecycle, so there
   * is no SDK-side session to clear. Subclasses that own session state (the
   * node OAuth subclass) override this to revoke and wipe the keychain.
   * Resolves successfully so callers can wire it into UI flows uniformly.
   */
  async signOut(): Promise<void> {
    // Trusted-token mode has no SDK-owned session to clear, but the host can
    // still observe the lifecycle — emit so listeners see a uniform signedOut.
    this.session.markSignedOut();
  }

  override async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const initialToken = await this.getInitialAccessToken();
    const url = this.buildUrl(path, options.query);
    const isMultipart = typeof FormData !== "undefined" && options.body instanceof FormData;
    const isBinaryBody =
      options.body instanceof ArrayBuffer ||
      options.body instanceof Uint8Array ||
      (typeof Blob !== "undefined" && options.body instanceof Blob);
    const onUploadProgress = options.onUploadProgress;
    // For progress-tracked multipart uploads we need to know the total byte
    // count and to be able to wrap each send in a fresh counting stream (for
    // the 401-retry path). Encoding the FormData to a Blob up front gives us
    // both — the encoded multipart payload (including boundaries) and the
    // exact Content-Type with that boundary.
    // Wrapping a multipart body for byte-level progress requires encoding
    // the whole FormData to a single in-memory Blob (so we know its exact
    // size and Content-Type with boundary). For a multi-hundred-MB upload
    // that's an O(payload) memory spike. We avoid it by ESTIMATING the
    // encoded size first — walking FormData parts and summing their .size
    // / encoded string length — and only wrap below PROGRESS_BLOB_MAX_BYTES.
    // Above the cap we ship the original FormData (lazily streamable by
    // fetch) and emit only coarse synthetic bookends, since the alternative
    // is a likely-OOM.
    //
    // For files.create() this only matters as a backstop — its chunked
    // path kicks in at 5 MB and emits per-chunk progress separately. The
    // cap here protects files.upload() and any future single-shot caller
    // that opts into progress for a huge payload.
    const PROGRESS_BLOB_MAX_BYTES = 100 * 1024 * 1024;
    const wantsProgressBlob = isMultipart && typeof onUploadProgress === "function";
    let progressBlob: Blob | undefined;
    let estimatedFormBytes = 0;
    if (wantsProgressBlob) {
      estimatedFormBytes = estimateFormDataBytes(options.body as FormData);
      if (estimatedFormBytes <= PROGRESS_BLOB_MAX_BYTES) {
        progressBlob = await new Response(options.body as FormData).blob();
      }
    }
    const bodyInit: BodyInit | undefined = isMultipart
      ? (options.body as FormData)
      : isBinaryBody
        ? (options.body as BodyInit)
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined;
    const send = (accessToken: string) => {
      // Emit the 0/total bookend per send so a 401 → refresh → retry shows
      // hosts a clean "we're restarting from byte 0" marker, instead of
      // silently resetting `loaded` partway through the listener's stream.
      // Without this, listeners that assume monotonic `loaded` would see
      // it climb on attempt 1, drop on attempt 2, climb again — the test
      // `tests/node/files.test.ts` documents the per-attempt-monotonic
      // shape, and consumers may rely on the 0-bookend to know when a
      // restart happened.
      if (wantsProgressBlob && onUploadProgress) {
        // Above the wrap cap we use the pre-encode estimate so listeners
        // still get a meaningful `total` (otherwise a 200 MB upload would
        // report total=0 on its bookend, which divides-by-zero in any
        // percent-driven UI).
        const total = progressBlob?.size ?? estimatedFormBytes;
        safeEmit(onUploadProgress, 0, total);
      }
      const init: RequestInit & { duplex?: "half" } = {
        method: options.method ?? "GET",
        // For multipart, let fetch set the Content-Type (with boundary). For
        // binary bodies the caller supplies `contentType` (or we default to
        // application/octet-stream below). Only JSON gets the auto-applied
        // application/json header from buildHeaders.
        headers: this.buildHeaders(
          accessToken,
          bodyInit !== undefined && !isMultipart && !isBinaryBody,
        ),
      };
      if (progressBlob && onUploadProgress) {
        init.body = progressStream(progressBlob, onUploadProgress);
        // Required by the WHATWG fetch spec when body is a stream; Node 20+
        // and Bun reject the call without it.
        init.duplex = "half";
        // We're sending the pre-encoded multipart bytes ourselves, so we have
        // to set the Content-Type (including boundary) — fetch only does that
        // automatically when body is a real FormData instance.
        (init.headers as Record<string, string>)["content-type"] = progressBlob.type;
      } else if (bodyInit !== undefined) {
        init.body = bodyInit;
        if (isBinaryBody) {
          (init.headers as Record<string, string>)["content-type"] =
            options.contentType ?? "application/octet-stream";
        }
      }
      if (options.signal) init.signal = options.signal;
      return this.options.fetch(url, init);
    };

    let res = await send(initialToken);
    if (res.status === 401) {
      await drainResponse(res);
      let freshToken: string;
      try {
        freshToken = await this.refreshAccessToken();
      } catch (err) {
        await this.onAuthFailure();
        throw err;
      }
      res = await send(freshToken);
      if (res.status === 401) {
        const body = await readErrorBody(res);
        await this.onAuthFailure();
        throw new UnifiedAIAuthError(
          "auth_retry_still_unauthorized",
          `request still 401 after refresh: ${formatBody(body)}`,
          401,
          body,
          headersToRecord(res.headers),
        );
      }
    }
    // Final bookend for the above-cap progress path. The wrapping branch
    // already emits total/total naturally as the last chunk drains, so
    // this only fires when we sent the FormData as-is. The `total` here
    // is the pre-encode estimate — a few hundred bytes off from the wire
    // truth, but stable enough for "upload finished" UI.
    if (res.ok && wantsProgressBlob && !progressBlob && onUploadProgress) {
      safeEmit(onUploadProgress, estimatedFormBytes, estimatedFormBytes);
    }
    if (!res.ok) {
      const status = res.status;
      const body = await readErrorBody(res);
      throw buildHttpError(
        httpErrorMessage("request", path, status, body),
        status,
        body,
        headersToRecord(res.headers),
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * Issue a request and return the raw response bytes plus selected metadata.
   * Used for binary endpoints — audio TTS bytes, video content downloads —
   * where the response is not JSON. Shares the same 401-refresh and typed-
   * error mapping as {@link request}.
   */
  override async requestBinary(
    path: string,
    options: RequestOptions = {},
  ): Promise<{
    bytes: ArrayBuffer;
    contentType: string;
    headers: Readonly<Record<string, string>>;
  }> {
    const initialToken = await this.getInitialAccessToken();
    const url = this.buildUrl(path, options.query);
    const isMultipart = typeof FormData !== "undefined" && options.body instanceof FormData;
    const bodyInit: BodyInit | undefined = isMultipart
      ? (options.body as FormData)
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined;
    const send = (accessToken: string) => {
      const init: RequestInit = {
        method: options.method ?? "GET",
        headers: this.buildHeaders(accessToken, bodyInit !== undefined && !isMultipart),
      };
      if (bodyInit !== undefined) init.body = bodyInit;
      if (options.signal) init.signal = options.signal;
      return this.options.fetch(url, init);
    };

    let res = await send(initialToken);
    if (res.status === 401) {
      await drainResponse(res);
      let freshToken: string;
      try {
        freshToken = await this.refreshAccessToken();
      } catch (err) {
        await this.onAuthFailure();
        throw err;
      }
      res = await send(freshToken);
      if (res.status === 401) {
        const body = await readErrorBody(res);
        await this.onAuthFailure();
        throw new UnifiedAIAuthError(
          "auth_retry_still_unauthorized",
          `request still 401 after refresh: ${formatBody(body)}`,
          401,
          body,
          headersToRecord(res.headers),
        );
      }
    }
    if (!res.ok) {
      const status = res.status;
      const body = await readErrorBody(res);
      throw buildHttpError(
        httpErrorMessage("requestBinary", path, status, body),
        status,
        body,
        headersToRecord(res.headers),
      );
    }
    const rawCt = res.headers.get("content-type") ?? "";
    const headers = headersToRecord(res.headers);
    // 204 No Content has no body by definition. Mirror request()'s
    // short-circuit so callers don't receive a 0-byte buffer that looks
    // like a successful download. Drain first — a misbehaving gateway can
    // attach a body to a 204 and leaving it un-read prevents keep-alive
    // socket reuse on undici/Bun.
    if (res.status === 204) {
      await drainResponse(res);
      throw new UnifiedAIError(
        "request_failed",
        `requestBinary to ${path} returned 204 No Content (no bytes to return)`,
        204,
        undefined,
        headers,
      );
    }
    // Defense against gateway error pages and provider misconfiguration: a
    // 200 with an unexpected Content-Type (HTML error page, JSON envelope)
    // would otherwise be silently returned as `audio` or `video` bytes.
    // Mirrors the analogous guard in stream() at the SSE content-type check.
    if (options.acceptedContentTypes && options.acceptedContentTypes.length > 0) {
      const ct = (rawCt.split(";")[0] ?? "").trim().toLowerCase();
      const ok = options.acceptedContentTypes.some((accepted) => {
        const a = accepted.toLowerCase();
        return a.endsWith("/") ? ct.startsWith(a) : ct === a;
      });
      if (!ok) {
        // Drain the body so the connection can be reused; cap the peek to
        // avoid swallowing megabytes of HTML into Error.message.
        const peek = (await readErrorBody(res)) ?? "";
        throw new UnifiedAIError(
          "request_failed",
          `requestBinary to ${path} expected one of [${options.acceptedContentTypes.join(", ")}], got ${rawCt || "<none>"}`,
          res.status,
          peek,
          headers,
        );
      }
    }
    const bytes = await res.arrayBuffer();
    return { bytes, contentType: rawCt, headers };
  }

  override async stream(
    path: string,
    options: RequestOptions = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const initialToken = await this.getInitialAccessToken();
    const url = this.buildUrl(path, options.query);
    const bodyText = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const send = (accessToken: string) => {
      const headers = this.buildHeaders(accessToken, bodyText !== undefined);
      headers.accept = "text/event-stream";
      const init: RequestInit = {
        method: options.method ?? "GET",
        headers,
      };
      if (bodyText !== undefined) init.body = bodyText;
      if (options.signal) init.signal = options.signal;
      return this.options.fetch(url, init);
    };

    let res = await send(initialToken);
    if (res.status === 401) {
      await drainResponse(res);
      let freshToken: string;
      try {
        freshToken = await this.refreshAccessToken();
      } catch (err) {
        await this.onAuthFailure();
        throw err;
      }
      res = await send(freshToken);
      if (res.status === 401) {
        const body = await readErrorBody(res);
        await this.onAuthFailure();
        throw new UnifiedAIAuthError(
          "auth_retry_still_unauthorized",
          `stream still 401 after refresh: ${formatBody(body)}`,
          401,
          body,
          headersToRecord(res.headers),
        );
      }
    }
    if (!res.ok) {
      const status = res.status;
      const body = await readErrorBody(res);
      throw buildHttpError(
        httpErrorMessage("stream", path, status, body),
        status,
        body,
        headersToRecord(res.headers),
      );
    }
    if (!res.body) {
      throw new UnifiedAIError(
        "request_failed",
        `stream to ${path} returned no body`,
        res.status,
        undefined,
        headersToRecord(res.headers),
      );
    }
    // Defence in depth: a 2xx with a non-SSE content-type (e.g. an endpoint that
    // ignored `stream: true` and returned JSON) would otherwise silently yield
    // zero events. Fail loudly so callers don't see a phantom empty stream.
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.toLowerCase().includes("text/event-stream")) {
      const body = await readErrorBody(res);
      throw new UnifiedAIError(
        "request_failed",
        `stream to ${path} expected text/event-stream, got ${ct || "<none>"}`,
        res.status,
        body,
        headersToRecord(res.headers),
      );
    }
    return res.body;
  }

  // ─── Hooks for subclasses ──────────────────────────────────────────────

  /** Returns the access token used on the initial request. */
  protected async getInitialAccessToken(): Promise<string> {
    if (this.options.token !== undefined) return this.resolveTrustedToken();
    // Same code as bootstrap() throws so consumers can branch on a single
    // condition to detect "browser entry imported but OAuth needed".
    throw new UnifiedError(
      "not_implemented",
      "no token configured. Pass `token` for trusted-token mode, or import UnifiedAI from '@unifiedai/sdk/node' for OAuth.",
    );
  }

  /**
   * Returns a fresh access token after a 401. The base implementation
   * coalesces concurrent calls when in trusted-token mode so a host whose
   * provider does real I/O (HTTP, IPC, keychain) only sees one refresh per
   * burst of 401s.
   */
  protected async refreshAccessToken(): Promise<string> {
    if (this.options.token !== undefined) {
      if (this.trustedRefreshPromise) return this.trustedRefreshPromise;
      const p = this.resolveTrustedToken().finally(() => {
        if (this.trustedRefreshPromise === p) this.trustedRefreshPromise = undefined;
      });
      this.trustedRefreshPromise = p;
      // Emit `refreshed` once per coalesced burst, not once per awaiting
      // caller. Attach to `p` (shared by all callers) rather than awaiting
      // here so the single-flight contract is preserved. The rejection
      // branch is a no-op — the real failure propagates via the returned `p`.
      p.then(
        () => this.session.markRefreshed(),
        () => {},
      );
      return p;
    }
    throw new UnifiedError(
      "not_implemented",
      "no refresh strategy available. Pass `token` for trusted-token mode, or import UnifiedAI from '@unifiedai/sdk/node' for OAuth.",
    );
  }

  /** Cleanup hook fired when refresh fails or a retry still 401s. */
  protected async onAuthFailure(): Promise<void> {
    // Base: nothing to clean. Host owns the trusted-token lifecycle.
  }

  protected async resolveTrustedToken(): Promise<string> {
    const t = this.options.token;
    if (t === undefined) {
      throw new UnifiedError("not_bootstrapped", "trusted token provider not set");
    }
    return typeof t === "function" ? await t() : t;
  }

  // ─── URL/header helpers (protected so subclasses can compose) ─────────

  protected buildUrl(path: string, query: RequestOptions["query"]): string {
    const base = this.options.apiUrl;
    const full = base
      ? `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`
      : path;
    if (!query) return full;
    const u = new URL(full);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  protected buildHeaders(accessToken: string, hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    // In trusted-token mode, an empty token means "let the fetch layer carry
    // auth" (e.g. cookies via credentials: include). Sending `Bearer ` with no
    // token would be rejected by most backends.
    if (accessToken) h.authorization = `Bearer ${accessToken}`;
    if (hasBody) h["content-type"] = "application/json";
    return h;
  }
}
