import type { TokenSet } from "../core/_internal/tokens";
import { type UnifiedAIOptions as BaseOptions, UnifiedAI as BaseUnifiedAI } from "../core/client";
import { UnifiedAIAuthError, UnifiedError } from "../core/errors";
import type { Identity } from "../core/identity";
import { type LoopbackServer, type OpenUrl, runBrowserPkce } from "./_internal/browser-auth";
import { type DiscoveryReader, createDefaultDiscoveryReader } from "./_internal/discovery";
import { type EnvReader, defaultEnvReader } from "./_internal/env";
import { requestHandoff } from "./_internal/handoff";
import { type KeychainAdapter, createDefaultKeychain } from "./_internal/keychain";
import { createNodeLoopback } from "./_internal/loopback";
import { defaultOpenUrl } from "./_internal/open-url";
import { refreshTokens } from "./_internal/refresh";
import { deriveRevokeUrl, revokeToken } from "./_internal/revoke";

const DEFAULT_AUTHORIZE_URL = "https://web.unifiedai.app/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://api.unifiedai.app/oauth/token";

// Refresh this many seconds before the access token's expiry by default. One
// minute gives an ample window for the refresh round-trip while keeping the
// token live for in-flight requests.
const DEFAULT_REFRESH_SKEW_SECONDS = 60;

// setTimeout delays are stored in a signed 32-bit int; anything larger fires
// immediately. We never schedule beyond this — on an early (clamped) wake we
// re-evaluate and reschedule the remainder.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

function envVar(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  return process.env[name];
}

/**
 * Options for the node UnifiedAI client. Extends the browser-safe base with
 * OAuth Authorization Code + PKCE machinery: loopback HTTP listener for the
 * redirect, OS keychain for token storage, discovery file for handoff, and
 * a configurable URL-opener for the consent page.
 */
export interface UnifiedAIOptions extends BaseOptions {
  authorizeUrl?: string;
  tokenUrl?: string;
  revokeUrl?: string;
  env?: EnvReader;
  discovery?: DiscoveryReader;
  keychain?: KeychainAdapter;
  openUrl?: OpenUrl;
  loopback?: LoopbackServer;
  /**
   * Deadline for the best-effort revoke fetch in signOut(). On timeout the
   * revoke is abandoned (no error thrown) and signOut proceeds to clear
   * local state — matches the existing best-effort semantics, just bounded.
   * Defaults to 5000ms.
   */
  revokeTimeoutMs?: number;
  /**
   * Refresh the access token this many seconds before it expires, instead of
   * waiting for a 401. Set to `0` to disable proactive refresh entirely (the
   * reactive 401-retry path still applies). Defaults to 60.
   */
  refreshSkewSeconds?: number;
}

/**
 * Node-capable UnifiedAI client. Adds OAuth bootstrap on top of the
 * trusted-token base. Both modes can coexist in a single instance: if a
 * `token` is supplied, the SDK uses trusted-token mode; otherwise it runs
 * the PKCE handshake on first request.
 */
export class UnifiedAI extends BaseUnifiedAI {
  private readonly authorizeUrl: string;
  private readonly tokenUrl: string;
  private readonly revokeUrl: string;
  private readonly env: EnvReader;
  private readonly discovery: DiscoveryReader;
  private readonly keychain: KeychainAdapter;
  private readonly openUrl: OpenUrl;
  private readonly loopback: LoopbackServer;
  private readonly revokeTimeoutMs: number | undefined;
  private readonly refreshSkewSeconds: number;
  private bootstrapPromise: Promise<void> | undefined;
  private refreshPromise: Promise<TokenSet> | undefined;
  private proactiveTimer: ReturnType<typeof setTimeout> | undefined;
  private tokens: TokenSet | undefined;
  // Cached client_id so onAuthFailure() can clear the keychain entry even
  // after this.tokens has been nulled out by a racing signOut.
  private lastClientId: string | undefined;
  // Bumped on every signOut / clearLocalSession so an in-flight refresh that
  // resolves after the session was cleared can detect the change and avoid
  // re-persisting valid tokens onto a freshly-cleared instance.
  private sessionGeneration = 0;

  constructor(options: UnifiedAIOptions = {}) {
    super(options);
    this.authorizeUrl =
      options.authorizeUrl ?? envVar("UNIFIEDAI_AUTHORIZE_URL") ?? DEFAULT_AUTHORIZE_URL;
    this.tokenUrl = options.tokenUrl ?? envVar("UNIFIEDAI_TOKEN_URL") ?? DEFAULT_TOKEN_URL;
    this.revokeUrl =
      options.revokeUrl ?? envVar("UNIFIEDAI_REVOKE_URL") ?? deriveRevokeUrl(this.tokenUrl);
    this.env = options.env ?? defaultEnvReader;
    this.discovery = options.discovery ?? createDefaultDiscoveryReader();
    this.keychain = options.keychain ?? createDefaultKeychain();
    this.openUrl = options.openUrl ?? defaultOpenUrl;
    this.loopback = options.loopback ?? createNodeLoopback();
    this.revokeTimeoutMs = options.revokeTimeoutMs;
    this.refreshSkewSeconds = options.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS;
  }

  override bootstrap(): Promise<void> {
    if (this.options.token !== undefined) return Promise.resolve();
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.doBootstrap()
        .then(() => {
          // Establishing tokens — from the keychain cache, a handoff, or a
          // fresh PKCE flow — is "signed in" from this instance's view. Emit
          // once (bootstrap is single-flight) and arm the proactive timer.
          if (this.tokens) {
            this.session.markSignedIn({
              expiresAt: this.tokens.expires_at * 1000,
              identity: this.identityFromTokens(this.tokens),
            });
            this.scheduleProactiveRefresh();
          }
        })
        .catch((err) => {
          this.bootstrapPromise = undefined;
          throw err;
        });
    }
    return this.bootstrapPromise;
  }

  override identity(): Identity {
    if (this.options.token !== undefined) {
      throw new UnifiedError(
        "not_bootstrapped",
        "identity() is unavailable in trusted-token mode; the host owns the user session",
      );
    }
    if (!this.tokens) {
      throw new UnifiedError("not_bootstrapped", "call bootstrap() before identity()");
    }
    return { user_id: this.tokens.user_id, client_id: this.tokens.client_id };
  }

  override async signOut(): Promise<void> {
    if (this.options.token !== undefined) {
      // Trusted-token mode: host owns the auth lifecycle; nothing for the SDK
      // to clear. Fall through to the base no-op for consistency.
      return super.signOut();
    }
    let clientId: string | undefined;
    try {
      clientId = this.resolveClientId();
    } catch {
      // appId unresolvable: no keychain entry to clear, just drop in-memory state.
    }

    // Snapshot the tokens to revoke BEFORE invalidating in-memory state so we
    // still have the original refresh_token to send to /oauth/revoke. Read
    // from `this.tokens` (and only fall back to the keychain when in-memory
    // state is missing) so the snapshot reflects the family the user actually
    // wants to end — not whatever a racing refresh might write moments later.
    //
    // A throwing keychain.get must NOT bypass clear + revoke — we fall back
    // to whatever this.tokens has (possibly null) and keep going. This
    // symmetrically protects the snapshot read the same way the clear path
    // below protects keychain.clear.
    let snapshot: TokenSet | null = this.tokens ?? null;
    if (!snapshot && clientId) {
      try {
        snapshot = (await this.keychain.get(clientId)) ?? null;
      } catch {
        // Snapshot unavailable; the in-memory clear below still runs and the
        // user will need to recover via signOut retry if a revoke is still
        // required server-side.
        snapshot = null;
      }
    }

    // Clear local session FIRST, then revoke. The revoke can take up to
    // revokeTimeoutMs; if local state were still live during that window, a
    // racing bootstrap() (e.g. user signs out then signs back in immediately)
    // would establish a fresh session that the trailing clearLocalSession
    // would then nuke. By clearing first we hold the snapshot in a local and
    // let bootstrap own the SDK state for the rest of the signOut. The
    // generation bump inside clearLocalSession also invalidates any in-flight
    // refresh's .then(persist), so it can't re-establish a session either.
    //
    // If clearLocalSession's keychain.clear throws (custom adapter, OS-level
    // failure), we STILL run the server-side revoke before propagating —
    // otherwise a keychain malfunction would leave the refresh-token family
    // live on the server, which is the worse failure direction.
    //
    // Boolean sentinel + value so a cursed `throw undefined` from the
    // adapter can't be swallowed by an `=== undefined` check at rethrow.
    let clearFailed = false;
    let clearError: unknown;
    try {
      await this.clearLocalSession(clientId, { throwOnKeychain: true });
    } catch (err) {
      clearFailed = true;
      clearError = err;
    }

    // In-memory tokens are cleared by clearLocalSession before its (possibly
    // throwing) keychain.clear, so the session is signed out regardless of the
    // keychain outcome — emit now so listeners aren't held hostage by a
    // best-effort revoke that may take seconds.
    this.session.markSignedOut();

    let revokeError: unknown;
    let revokeFailed = false;
    if (snapshot) {
      // Best-effort: server-side family revoke. Failure (or a hung endpoint)
      // must not block local sign-out — revokeToken has its own AbortSignal
      // timeout, defaulting to 5s and overridable via revokeTimeoutMs. The
      // token sent here is the snapshot captured above, so we always revoke
      // the family the user authenticated with — regardless of what
      // bootstrap may have installed concurrently after clearLocalSession.
      //
      // revokeToken is contracted to never throw, but defend against future
      // regressions / custom fetch adapters that throw synchronously: if it
      // somehow rejects, capture but don't drop a pre-existing clearError.
      try {
        await revokeToken({
          revokeUrl: this.revokeUrl,
          clientId: snapshot.client_id,
          token: snapshot.refresh_token,
          tokenTypeHint: "refresh_token",
          fetch: this.options.fetch,
          ...(this.revokeTimeoutMs !== undefined ? { timeoutMs: this.revokeTimeoutMs } : {}),
        });
      } catch (err) {
        revokeFailed = true;
        revokeError = err;
      }
    }

    // Surface failures to the caller. Single failures rethrow the original
    // value verbatim (preserves identity — including a cursed `throw undefined`
    // from the adapter). Dual failures wrap both via AggregateError so the
    // caller can inspect `.errors` to recover each — fabricating a synthetic
    // Error from the thrown value would lose the original identity (e.g.
    // `Error('undefined')` instead of the actual undefined).
    if (clearFailed && revokeFailed) {
      throw new AggregateError(
        [clearError, revokeError],
        "signOut: keychain.clear and revoke both failed",
      );
    }
    if (clearFailed) throw clearError;
    if (revokeFailed) throw revokeError;
  }

  // ─── Hooks: defer to base in trusted-token mode, OAuth path otherwise ──

  protected override async getInitialAccessToken(): Promise<string> {
    if (this.options.token !== undefined) return super.getInitialAccessToken();
    if (!this.tokens) {
      throw new UnifiedError("not_bootstrapped", "call bootstrap() before making requests");
    }
    return this.tokens.access_token;
  }

  protected override async refreshAccessToken(): Promise<string> {
    if (this.options.token !== undefined) return super.refreshAccessToken();
    const fresh = await this.ensureFreshToken();
    return fresh.access_token;
  }

  protected override async onAuthFailure(): Promise<void> {
    if (this.options.token !== undefined) return; // trusted-token: nothing local to clear
    // Prefer the live token's client_id; fall back to the cached id from the
    // last successful persist() so we still clear the keychain when tokens
    // were nulled out by a racing signOut between the 401 and this hook.
    const clientId = this.tokens?.client_id ?? this.lastClientId;
    await this.clearLocalSession(clientId);
    // A failed refresh (or a retry that still 401s) means the session can no
    // longer be renewed — surface it as expired so hosts can prompt re-auth.
    this.session.markExpired();
  }

  // ─── OAuth internals ────────────────────────────────────────────────────

  /**
   * Single-flight: concurrent callers share one refresh promise per cycle.
   * Resolves to the new TokenSet on success; rejects with UnifiedAIAuthError on failure.
   */
  private ensureFreshToken(): Promise<TokenSet> {
    if (this.refreshPromise) return this.refreshPromise;
    const current = this.tokens;
    if (!current) {
      return Promise.reject(
        new UnifiedAIAuthError("auth_refresh_failed", "no tokens available to refresh"),
      );
    }
    // Snapshot the generation so a racing signOut() can invalidate this
    // refresh after the fact — without this guard, the .then(persist) below
    // would re-write valid tokens onto an instance the user already cleared.
    const generationAtStart = this.sessionGeneration;
    const p = refreshTokens({
      tokenUrl: this.tokenUrl,
      clientId: current.client_id,
      refreshToken: current.refresh_token,
      fetch: this.options.fetch,
    })
      .catch((err) => {
        // Genuine refresh failure (network / invalid_grant). Surface it as an
        // `error` event before rethrowing so hosts can observe the cause; the
        // resulting `expired` event comes later from onAuthFailure. The
        // generation-guard rejection below is NOT a refresh failure, so it's
        // intentionally outside this catch.
        this.session.emitError(err);
        throw err;
      })
      .then(async (next) => {
        if (this.sessionGeneration !== generationAtStart) {
          // signOut (or some other clearLocalSession) ran while we were
          // refreshing. Don't restore tokens or write to the keychain;
          // surface as an auth failure so callers don't act on stale state.
          throw new UnifiedAIAuthError(
            "auth_refresh_failed",
            "session was cleared while refresh was in flight",
          );
        }
        await this.persist(next.client_id, next);
        // persist() guards a narrower window: a signOut landing DURING
        // keychain.set rolls back the just-written tokens. If that happened,
        // don't announce a refresh on a session the user already ended.
        if (this.sessionGeneration === generationAtStart) {
          this.session.markRefreshed({
            expiresAt: next.expires_at * 1000,
            identity: this.identityFromTokens(next),
          });
          this.scheduleProactiveRefresh();
        }
        return next;
      })
      .finally(() => {
        if (this.refreshPromise === p) this.refreshPromise = undefined;
      });
    this.refreshPromise = p;
    return p;
  }

  /**
   * Force the next bootstrap() to actually re-run, then clear the keychain
   * entry. throwOnKeychain=true surfaces unexpected keychain errors to
   * signOut callers; the auth-failure path swallows them since it's already
   * throwing.
   */
  private async clearLocalSession(
    clientId: string | undefined,
    opts: { throwOnKeychain?: boolean } = {},
  ): Promise<void> {
    // Bump generation FIRST so any in-flight refresh's .then(persist)
    // observes the change before doing anything else — the bump is the
    // semantic 'session ended' marker, everything below is cleanup.
    this.sessionGeneration++;
    this.tokens = undefined;
    this.lastClientId = undefined;
    this.bootstrapPromise = undefined;
    this.refreshPromise = undefined;
    this.cancelProactiveRefresh();
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
      this.tokens = cached;
      this.lastClientId = clientId;
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
    // Snapshot the generation so we can detect a signOut that races with
    // keychain.set's underlying I/O. The check at the start of
    // ensureFreshToken's .then guards the common case; this second check
    // catches the narrower window where signOut runs DURING this method
    // (between the synchronous assignments below and keychain.set's await).
    const generationAtStart = this.sessionGeneration;
    this.tokens = tokens;
    this.lastClientId = clientId;
    try {
      await this.keychain.set(clientId, tokens);
    } catch (err) {
      if (err instanceof UnifiedError && err.code === "keychain_unavailable") {
        return;
      }
      throw err;
    }
    if (this.sessionGeneration !== generationAtStart) {
      // signOut (or some other clearLocalSession) ran while keychain.set was
      // resolving. Roll back both the in-memory and on-disk writes so we
      // don't end up with a freshly-persisted token family that the user
      // explicitly cleared. Best-effort: keychain.clear errors are swallowed.
      this.tokens = undefined;
      this.lastClientId = undefined;
      try {
        await this.keychain.clear(clientId);
      } catch {
        // ignore — clearLocalSession will have already attempted its own clear
      }
    }
  }

  private identityFromTokens(tokens: TokenSet): Identity {
    return { user_id: tokens.user_id, client_id: tokens.client_id };
  }

  // ─── Proactive refresh ──────────────────────────────────────────────────

  /**
   * Arm a one-shot timer to refresh the access token shortly before it
   * expires. Reschedules itself after each successful refresh (the
   * ensureFreshToken success path calls this again). No-op in trusted-token
   * mode, when proactive refresh is disabled (skew 0), when no tokens are
   * held, or when the token is already inside the skew window — in that last
   * case the reactive 401 path covers it, and scheduling a zero-delay refresh
   * could hot-loop against a server issuing very short-lived tokens.
   */
  private scheduleProactiveRefresh(): void {
    this.cancelProactiveRefresh();
    if (this.options.token !== undefined) return;
    if (this.refreshSkewSeconds <= 0) return;
    const tokens = this.tokens;
    if (!tokens) return;

    const skewMs = this.refreshSkewSeconds * 1000;
    const fireAt = tokens.expires_at * 1000 - skewMs;
    const delay = fireAt - Date.now();
    if (delay <= 0) return;

    const generationAtSchedule = this.sessionGeneration;
    const timer = setTimeout(
      () => {
        this.proactiveTimer = undefined;
        // A signOut/refresh since scheduling invalidates this fire.
        if (this.sessionGeneration !== generationAtSchedule) return;
        const current = this.tokens;
        if (!current) return;
        // We clamp long delays to MAX_TIMER_DELAY_MS; if we woke early because of
        // that clamp, the token isn't due yet — reschedule the remainder.
        if (current.expires_at * 1000 - skewMs > Date.now()) {
          this.scheduleProactiveRefresh();
          return;
        }
        void this.proactiveRefresh();
      },
      Math.min(delay, MAX_TIMER_DELAY_MS),
    );

    // Don't let a pending refresh timer keep a Node process alive on its own.
    (timer as { unref?: () => void }).unref?.();
    this.proactiveTimer = timer;
  }

  private cancelProactiveRefresh(): void {
    if (this.proactiveTimer !== undefined) {
      clearTimeout(this.proactiveTimer);
      this.proactiveTimer = undefined;
    }
  }

  /**
   * Drive a pre-expiry refresh through the same single-flight path as the
   * reactive 401 retry, so a proactive refresh and a concurrent 401 coalesce
   * into one network call. On failure, tear the session down exactly as the
   * reactive path would (clear + `expired` event) — ensureFreshToken already
   * emitted the `error`.
   */
  private async proactiveRefresh(): Promise<void> {
    try {
      await this.ensureFreshToken();
    } catch {
      await this.onAuthFailure();
    }
  }
}
