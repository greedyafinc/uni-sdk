import { Chat } from "../resources/chat";
import { Messages } from "../resources/messages";
import { Models } from "../resources/models";
import { Responses } from "../resources/responses";
import { Usage } from "../resources/usage";
import {
  drainResponse,
  formatBody,
  httpErrorMessage,
  readErrorBody,
} from "./_internal/http-errors";
import { Core, type CoreOptions, type RequestOptions } from "./core";
import {
  UnifiedAIAuthError,
  UnifiedAIError,
  UnifiedError,
  httpErrorCodeFromStatus,
} from "./errors";
import type { Identity } from "./identity";

const DEFAULT_API_URL = "https://api.unifiedai.app";

// Browser bundles don't have `process`. Read env vars defensively so importing
// the SDK in a Vite/Workers/edge runtime doesn't throw at construction time.
function envVar(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  return process.env[name];
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

  private trustedRefreshPromise: Promise<string> | undefined;

  constructor(options: UnifiedAIOptions = {}) {
    super({
      ...options,
      apiUrl: options.apiUrl ?? envVar("UNIFIEDAI_API_URL") ?? DEFAULT_API_URL,
    });
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

  async signOut(): Promise<void> {
    // Trusted-token mode has no SDK-owned session to clear.
  }

  override async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const initialToken = await this.getInitialAccessToken();
    const url = this.buildUrl(path, options.query);
    const bodyText = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const send = (accessToken: string) => {
      const init: RequestInit = {
        method: options.method ?? "GET",
        headers: this.buildHeaders(accessToken, bodyText !== undefined),
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
          `request still 401 after refresh: ${formatBody(body)}`,
          401,
          body,
        );
      }
    }
    if (!res.ok) {
      const status = res.status;
      const body = await readErrorBody(res);
      throw new UnifiedAIError(
        httpErrorCodeFromStatus(status),
        httpErrorMessage("request", path, status, body),
        status,
        body,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
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
        );
      }
    }
    if (!res.ok) {
      const status = res.status;
      const body = await readErrorBody(res);
      throw new UnifiedAIError(
        httpErrorCodeFromStatus(status),
        httpErrorMessage("stream", path, status, body),
        status,
        body,
      );
    }
    if (!res.body) {
      throw new UnifiedAIError(
        "request_failed",
        `stream to ${path} returned no body`,
        res.status,
        undefined,
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
