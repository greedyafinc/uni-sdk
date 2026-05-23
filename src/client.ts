import { type LoopbackServer, type OpenUrl, runBrowserPkce } from "./_internal/browser-auth";
import { type DiscoveryReader, createDefaultDiscoveryReader } from "./_internal/discovery";
import { type EnvReader, defaultEnvReader } from "./_internal/env";
import { requestHandoff } from "./_internal/handoff";
import { type KeychainAdapter, createDefaultKeychain } from "./_internal/keychain";
import { createNodeLoopback } from "./_internal/loopback";
import { defaultOpenUrl } from "./_internal/open-url";
import { refreshTokens } from "./_internal/refresh";
import { deriveRevokeUrl, revokeToken } from "./_internal/revoke";
import type { TokenSet } from "./_internal/tokens";
import { Core, type CoreOptions, type RequestOptions } from "./core";
import {
  UnifiedAIAuthError,
  UnifiedAIError,
  UnifiedError,
  httpErrorCodeFromStatus,
} from "./errors";
import type { Identity } from "./identity";
import { Chat } from "./resources/chat";
import { Messages } from "./resources/messages";
import { Models } from "./resources/models";
import { Responses } from "./resources/responses";
import { Usage } from "./resources/usage";

const DEFAULT_AUTHORIZE_URL = "https://web.unifiedai.app/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://api.unifiedai.app/oauth/token";

export interface UnifiedAIOptions extends CoreOptions {
  authorizeUrl?: string;
  tokenUrl?: string;
  revokeUrl?: string;
  env?: EnvReader;
  discovery?: DiscoveryReader;
  keychain?: KeychainAdapter;
  openUrl?: OpenUrl;
  loopback?: LoopbackServer;
}

const tokenStore = new WeakMap<UnifiedAI, TokenSet>();

export class UnifiedAI extends Core {
  private readonly authorizeUrl: string;
  private readonly tokenUrl: string;
  private readonly revokeUrl: string;
  private readonly env: EnvReader;
  private readonly discovery: DiscoveryReader;
  private readonly keychain: KeychainAdapter;
  private readonly openUrl: OpenUrl;
  private readonly loopback: LoopbackServer;
  private bootstrapPromise: Promise<void> | undefined;
  private refreshPromise: Promise<TokenSet> | undefined;

  readonly models: Models = new Models(this);
  readonly usage: Usage = new Usage(this);
  readonly chat: Chat = new Chat(this);
  readonly responses: Responses = new Responses(this);
  readonly messages: Messages = new Messages(this);

  constructor(options: UnifiedAIOptions = {}) {
    super(options);
    this.authorizeUrl =
      options.authorizeUrl ?? process.env.UNIFIEDAI_AUTHORIZE_URL ?? DEFAULT_AUTHORIZE_URL;
    this.tokenUrl = options.tokenUrl ?? process.env.UNIFIEDAI_TOKEN_URL ?? DEFAULT_TOKEN_URL;
    this.revokeUrl =
      options.revokeUrl ?? process.env.UNIFIEDAI_REVOKE_URL ?? deriveRevokeUrl(this.tokenUrl);
    this.env = options.env ?? defaultEnvReader;
    this.discovery = options.discovery ?? createDefaultDiscoveryReader();
    this.keychain = options.keychain ?? createDefaultKeychain();
    this.openUrl = options.openUrl ?? defaultOpenUrl;
    this.loopback = options.loopback ?? createNodeLoopback();
  }

  bootstrap(): Promise<void> {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.doBootstrap().catch((err) => {
        this.bootstrapPromise = undefined;
        throw err;
      });
    }
    return this.bootstrapPromise;
  }

  identity(): Identity {
    const t = tokenStore.get(this);
    if (!t) {
      throw new UnifiedError("not_bootstrapped", "call bootstrap() before identity()");
    }
    return { user_id: t.user_id, client_id: t.client_id };
  }

  async signOut(): Promise<void> {
    let clientId: string | undefined;
    try {
      clientId = this.resolveClientId();
    } catch {
      // appId unresolvable: no keychain entry to clear, just drop in-memory state
    }
    const tokens = tokenStore.get(this) ?? (clientId ? await this.keychain.get(clientId) : null);
    if (tokens) {
      // Best-effort: server-side family revoke. Failure must not block local sign-out.
      await revokeToken({
        revokeUrl: this.revokeUrl,
        clientId: tokens.client_id,
        token: tokens.refresh_token,
        tokenTypeHint: "refresh_token",
        fetch: this.options.fetch,
      });
    }
    await this.clearLocalSession(clientId, { throwOnKeychain: true });
  }

  override async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const tokens = tokenStore.get(this);
    if (!tokens) {
      throw new UnifiedError("not_bootstrapped", "call bootstrap() before making requests");
    }
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

    let res = await send(tokens.access_token);
    if (res.status === 401) {
      await drain(res);
      let fresh: TokenSet;
      try {
        fresh = await this.ensureFreshToken();
      } catch (err) {
        await this.clearLocalSession(tokens.client_id);
        throw err;
      }
      res = await send(fresh.access_token);
      if (res.status === 401) {
        const body = await readErrorBody(res);
        await this.clearLocalSession(fresh.client_id);
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
        `request to ${path} returned ${status}`,
        status,
        body,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * Single-flight: concurrent callers share one refresh promise per cycle.
   * Resolves to the new TokenSet on success; rejects with UnifiedAIAuthError on failure.
   */
  private ensureFreshToken(): Promise<TokenSet> {
    if (this.refreshPromise) return this.refreshPromise;
    const current = tokenStore.get(this);
    if (!current) {
      return Promise.reject(
        new UnifiedAIAuthError("auth_refresh_failed", "no tokens available to refresh"),
      );
    }
    const p = refreshTokens({
      tokenUrl: this.tokenUrl,
      clientId: current.client_id,
      refreshToken: current.refresh_token,
      fetch: this.options.fetch,
    })
      .then(async (next) => {
        await this.persist(next.client_id, next);
        return next;
      })
      .finally(() => {
        if (this.refreshPromise === p) this.refreshPromise = undefined;
      });
    this.refreshPromise = p;
    return p;
  }

  private buildUrl(path: string, query: RequestOptions["query"]): string {
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

  private buildHeaders(accessToken: string, hasBody: boolean): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    if (hasBody) h["content-type"] = "application/json";
    return h;
  }

  // Force next bootstrap() to actually re-run, then clear the keychain entry.
  // throwOnKeychain=true surfaces unexpected keychain errors to signOut callers;
  // the auth-failure path swallows them since it's already throwing.
  private async clearLocalSession(
    clientId: string | undefined,
    opts: { throwOnKeychain?: boolean } = {},
  ): Promise<void> {
    tokenStore.delete(this);
    this.bootstrapPromise = undefined;
    this.refreshPromise = undefined;
    if (!clientId) return;
    try {
      await this.keychain.clear(clientId);
    } catch (err) {
      if (!opts.throwOnKeychain) return;
      if (err instanceof UnifiedError && err.code === "keychain_unavailable") return;
      throw err;
    }
  }

  private async doBootstrap(): Promise<void> {
    const clientId = this.resolveClientId();

    const cached = await this.keychain.get(clientId);
    if (cached) {
      tokenStore.set(this, cached);
      return;
    }

    const envSnapshot = this.env.read();
    if (envSnapshot.handoffPort !== undefined) {
      const tokens = await this.tryHandoff(envSnapshot.handoffPort, clientId);
      if (tokens) {
        await this.persist(clientId, tokens);
        return;
      }
    }

    const disc = await this.discovery.read();
    if (disc) {
      const tokens = await this.tryHandoff(disc.port, clientId);
      if (tokens) {
        await this.persist(clientId, tokens);
        return;
      }
    }

    const tokens = await runBrowserPkce({
      clientId,
      authorizeUrl: this.authorizeUrl,
      tokenUrl: this.tokenUrl,
      fetch: this.options.fetch,
      openUrl: this.openUrl,
      loopback: this.loopback,
    });
    await this.persist(clientId, tokens);
  }

  private resolveClientId(): string {
    const configured = this.options.appId;
    if (configured) return configured;
    const fromEnv = this.env.read().clientId;
    if (fromEnv) return fromEnv;
    throw new UnifiedError(
      "not_bootstrapped",
      "appId is required (set it in UnifiedAIOptions or via UNIFIEDAI_CLIENT_ID)",
    );
  }

  private async tryHandoff(port: number, clientId: string): Promise<TokenSet | null> {
    try {
      return await requestHandoff({ port, clientId, fetch: this.options.fetch });
    } catch (err) {
      if (err instanceof UnifiedError && err.code === "handoff_unreachable") {
        return null;
      }
      throw err;
    }
  }

  private async persist(clientId: string, tokens: TokenSet): Promise<void> {
    tokenStore.set(this, tokens);
    try {
      await this.keychain.set(clientId, tokens);
    } catch (err) {
      if (err instanceof UnifiedError && err.code === "keychain_unavailable") {
        return;
      }
      throw err;
    }
  }
}

// Cap the length of server-body excerpts in error messages so a runaway HTML
// error page doesn't flood the surfaced UnifiedAIError.message.
const MAX_ERROR_BODY_CHARS = 400;

function formatBody(body: unknown): string {
  if (body === undefined || body === null) return "<empty body>";
  if (typeof body === "string") return body.slice(0, MAX_ERROR_BODY_CHARS);
  try {
    return JSON.stringify(body).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return "<unserializable body>";
  }
}

async function drain(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    // ignore
  }
}

async function readErrorBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
