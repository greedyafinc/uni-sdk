import { type LoopbackServer, type OpenUrl } from "../auth/browser-sign-in.js";
import { type UnifiedAIOptions as BaseOptions, UnifiedAI as BaseUnifiedAI } from "../core/client.js";
import type { Identity } from "../core/identity.js";
import { type DiscoveryReader } from "./_internal/discovery.js";
import { type EnvReader } from "./_internal/env.js";
import { type KeychainAdapter } from "./_internal/keychain.js";
/**
 * Structured observability event fired at each step of the node client's auth
 * machinery: the bootstrap ladder (keychain → env handoff → discovery handoff
 * → browser PKCE), token refresh, and sign-out. Events carry only minimal,
 * non-sensitive fields — never token values.
 */
export type AuthEvent = {
    type: "keychain_lookup";
    result: "hit" | "miss" | "unavailable";
} | {
    type: "handoff_attempt";
    source: "env" | "discovery";
    port: number;
} | {
    type: "handoff_result";
    source: "env" | "discovery";
    result: "success" | "unreachable" | "not_installed" | "error";
} | {
    type: "browser_pkce_start";
} | {
    type: "refresh_start";
} | {
    type: "refresh_success";
} | {
    type: "refresh_failure";
    code: string | undefined;
} | {
    type: "sign_out";
};
export type AuthEventListener = (event: AuthEvent) => void;
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
     * Deadline in milliseconds for the browser PKCE sign-in to complete (the
     * time between opening the consent page and the OAuth redirect hitting the
     * loopback listener). On timeout, bootstrap() rejects with `auth_timeout`
     * and the loopback server is closed instead of waiting forever on a flow
     * the user abandoned. Ignored when a custom `loopback` is supplied (the
     * custom server owns its own deadline). Defaults to 5 minutes.
     */
    signInTimeoutMs?: number;
    /**
     * Refresh the access token this many seconds before it expires, instead of
     * waiting for a 401. Set to `0` to disable proactive refresh entirely (the
     * reactive 401-retry path still applies). Defaults to 60.
     */
    refreshSkewSeconds?: number;
    /**
     * Observability hook for the auth machinery. Fired synchronously at each
     * auth-ladder step (keychain lookup, handoff attempts, browser PKCE start),
     * on token refresh start/success/failure, and on sign-out. Events never
     * contain token values. A throwing listener is isolated — it cannot break
     * auth. Use for telemetry and debugging "why did my CLI open a browser?".
     */
    onAuthEvent?: AuthEventListener;
}
/**
 * Node-capable UnifiedAI client. Adds OAuth bootstrap on top of the
 * trusted-token base. Both modes can coexist in a single instance: if a
 * `token` is supplied, the SDK uses trusted-token mode; otherwise it runs
 * the PKCE handshake on first request.
 */
export declare class UnifiedAI extends BaseUnifiedAI {
    private readonly authorizeUrl;
    private readonly tokenUrl;
    private readonly revokeUrl;
    private readonly env;
    private readonly discovery;
    private readonly keychain;
    private readonly openUrl;
    private readonly loopback;
    private readonly revokeTimeoutMs;
    private readonly refreshSkewSeconds;
    private readonly onAuthEvent;
    private autoBootstrapArmed;
    private bootstrapPromise;
    private refreshPromise;
    private proactiveTimer;
    private tokens;
    private lastClientId;
    private sessionGeneration;
    constructor(options?: UnifiedAIOptions);
    /**
     * Deliver an auth event to the host's listener. A throwing listener is
     * isolated — telemetry must never break the auth machinery.
     */
    private emitAuthEvent;
    get serverCapable(): boolean;
    /**
     * Run the auth ladder (keychain → handoff → browser PKCE) and establish a
     * session.
     *
     * Racing with signOut(): if the host calls signOut() while a bootstrap is
     * still in flight (e.g. a browser PKCE consent page is open), the signOut
     * wins — bootstrap() rejects with a UnifiedError of code `"aborted"`, the
     * session stays `signed_out` (no `signedIn` event fires after the
     * `signedOut` event), no tokens are kept in memory or in the keychain, and
     * any token set minted mid-ladder is revoked server-side best-effort so the
     * fresh refresh-token family isn't left live. Call bootstrap() again to
     * sign back in deliberately.
     */
    bootstrap(): Promise<void>;
    identity(): Identity;
    signOut(): Promise<void>;
    protected getInitialAccessToken(): Promise<string>;
    protected refreshAccessToken(): Promise<string>;
    protected onAuthFailure(): Promise<void>;
    /**
     * Single-flight: concurrent callers share one refresh promise per cycle.
     * Resolves to the new TokenSet on success; rejects with UnifiedAIAuthError on failure.
     */
    private ensureFreshToken;
    /**
     * Force the next bootstrap() to actually re-run, then clear the keychain
     * entry. throwOnKeychain=true surfaces unexpected keychain errors to
     * signOut callers; the auth-failure path swallows them since it's already
     * throwing.
     */
    private clearLocalSession;
    /**
     * The auth ladder. `generationAtStart` is the sessionGeneration snapshot
     * taken by bootstrap() before the ladder's first await; every step that
     * installs tokens re-checks it so a concurrent signOut() aborts the ladder
     * instead of being silently resurrected.
     */
    private doBootstrap;
    /**
     * Persist a token set minted mid-ladder (handoff or browser PKCE), honoring
     * a concurrent signOut(). Unlike the keychain-cached path, these tokens are
     * a NEW refresh-token family the racing signOut could not have snapshotted —
     * so when the generation moved during the ladder, persist() has rolled the
     * write back and we additionally revoke the fresh family server-side
     * (best-effort, mirroring signOut) before rejecting with `aborted`.
     */
    private persistBootstrapTokens;
    /**
     * Best-effort server-side revoke of a token set that was minted during a
     * bootstrap ladder a concurrent signOut() invalidated. Mirrors signOut's
     * revoke call (same endpoint, bounded by revokeTimeoutMs) so the
     * freshly-created refresh-token family isn't left live. Never throws.
     */
    private revokeAbandonedTokens;
    private resolveClientId;
    /**
     * Attempt a token handoff against a local broker port. Returns null to fall
     * through to the next bootstrap ladder step; throws to abort bootstrap.
     *
     * requestHandoff produces exactly two error codes:
     *
     * - `handoff_unreachable` — network failure, timeout, malformed payload, or
     *   any non-404 HTTP error (including a broker refusing the request). Always
     *   fall-through-able: there is no live, cooperating broker on this port.
     * - `app_not_installed` — the endpoint answered 404. How much that means
     *   depends on where the port came from, hence `source`:
     *     - `"env"`: the desktop app injected UNIFIEDAI_HANDOFF_PORT into this
     *       exact child process, so the 404 came from the real, live broker and
     *       is authoritative — this app genuinely isn't installed. Abort so the
     *       caller sees the real problem instead of a surprise browser prompt.
     *     - `"discovery"`: the port came from a JSON file on disk that can
     *       outlive the desktop app; an unrelated local server that recycled
     *       the port also answers 404. Not authoritative — treat it like
     *       unreachable and fall through to browser PKCE.
     */
    private tryHandoff;
    /**
     * Install a token set in memory and the keychain, unless a signOut has
     * moved the session generation past `generationAtStart` — in which case
     * both writes are rolled back. Callers supply the generation snapshot taken
     * at the START of their flow (the bootstrap ladder or the refresh network
     * call), not at persist entry: snapshotting here would miss a signOut that
     * landed earlier in the flow, silently resurrecting a session the user
     * already ended.
     */
    private persist;
    private identityFromTokens;
    /**
     * Arm a one-shot timer to refresh the access token shortly before it
     * expires. Reschedules itself after each successful refresh (the
     * ensureFreshToken success path calls this again). No-op in trusted-token
     * mode, when proactive refresh is disabled (skew 0), when no tokens are
     * held, or when the token is already inside the skew window — in that last
     * case the reactive 401 path covers it, and scheduling a zero-delay refresh
     * could hot-loop against a server issuing very short-lived tokens.
     */
    private scheduleProactiveRefresh;
    private cancelProactiveRefresh;
    /**
     * Drive a pre-expiry refresh through the same single-flight path as the
     * reactive 401 retry, so a proactive refresh and a concurrent 401 coalesce
     * into one network call. On failure, tear the session down exactly as the
     * reactive path would (clear + `expired` event) — ensureFreshToken already
     * emitted the `error`.
     */
    private proactiveRefresh;
}
//# sourceMappingURL=client.d.ts.map