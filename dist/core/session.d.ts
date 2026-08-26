import type { Identity } from "./identity.js";
/**
 * Lifecycle state of the SDK's auth session.
 *
 * - `active`: the SDK holds a usable session (a configured trusted token, or
 *   OAuth tokens that have not yet expired).
 * - `expired`: a refresh failed or the token lapsed without a successful
 *   renewal — the host must re-authenticate.
 * - `signed_out`: the host (or the SDK on the host's behalf) ended the session.
 */
export type SessionStatus = "active" | "expired" | "signed_out";
/**
 * Immutable snapshot of the session at the moment an event fired. `expiresAt`
 * is epoch **milliseconds** (not seconds) so it compares directly against
 * `Date.now()`; it is `undefined` in trusted-token mode where the host owns
 * the token lifecycle and the SDK has no expiry information.
 */
export interface SessionSnapshot {
    readonly status: SessionStatus;
    readonly expiresAt: number | undefined;
    readonly identity: Identity | undefined;
}
export type SessionEventType = "signedIn" | "refreshed" | "signedOut" | "expired" | "error";
/**
 * Emitted to {@link Session.onChange} listeners. `error` is only present on
 * `"error"` events and carries the underlying failure (e.g. the rejection from
 * a failed token refresh).
 */
export interface SessionEvent {
    readonly type: SessionEventType;
    readonly session: SessionSnapshot;
    readonly error?: unknown;
}
export type SessionListener = (event: SessionEvent) => void;
/**
 * Observable auth-session surface. The host reads {@link isAuthenticated},
 * {@link expiresAt} and {@link identity}, and subscribes via {@link onChange}
 * to react to sign-in / refresh / sign-out / expiry without polling.
 *
 * Mutator methods (markSignedIn, markRefreshed, …) are driven by the client
 * and are not part of the host-facing contract.
 */
export declare class Session {
    private readonly listeners;
    private _status;
    private _expiresAt;
    private _identity;
    constructor(initialStatus?: SessionStatus);
    get status(): SessionStatus;
    /** Epoch milliseconds at which the access token expires, or undefined. */
    get expiresAt(): number | undefined;
    /** Cached identity for the active session, or undefined. */
    get identity(): Identity | undefined;
    /**
     * True when the session is `active` and (if expiry is known) not past its
     * expiry instant. Trusted-token sessions report `true` while a token is
     * configured, since the SDK can't see their expiry.
     */
    isAuthenticated(): boolean;
    snapshot(): SessionSnapshot;
    /**
     * Subscribe to session lifecycle events. Returns an unsubscribe function.
     * A throwing listener is isolated — its error is swallowed so one bad host
     * callback can't break the SDK or starve the other listeners.
     */
    onChange(listener: SessionListener): () => void;
    /**
     * @internal
     * Unlike {@link markRefreshed}, this intentionally has NO `signed_out`
     * guard: an explicit bootstrap() after signOut is the legitimate re-auth
     * path and MUST transition `signed_out` → `active`. Session can't tell a
     * deliberate re-sign-in from a stale in-flight one, so protection against
     * a signOut racing a pending bootstrap lives in the node client's
     * sessionGeneration guard (see bootstrap()/persist() in node/client.ts).
     */
    markSignedIn(opts?: {
        expiresAt?: number;
        identity?: Identity;
    }): void;
    /** @internal */
    markRefreshed(opts?: {
        expiresAt?: number;
        identity?: Identity;
    }): void;
    /** @internal */
    markSignedOut(): void;
    /** @internal */
    markExpired(): void;
    /** @internal */
    emitError(error: unknown): void;
    private emit;
}
//# sourceMappingURL=session.d.ts.map