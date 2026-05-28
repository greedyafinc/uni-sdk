import type { Identity } from "./identity";

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
export class Session {
  private readonly listeners = new Set<SessionListener>();
  private _status: SessionStatus;
  private _expiresAt: number | undefined;
  private _identity: Identity | undefined;

  constructor(initialStatus: SessionStatus = "signed_out") {
    this._status = initialStatus;
  }

  get status(): SessionStatus {
    return this._status;
  }

  /** Epoch milliseconds at which the access token expires, or undefined. */
  get expiresAt(): number | undefined {
    return this._expiresAt;
  }

  /** Cached identity for the active session, or undefined. */
  get identity(): Identity | undefined {
    return this._identity;
  }

  /**
   * True when the session is `active` and (if expiry is known) not past its
   * expiry instant. Trusted-token sessions report `true` while a token is
   * configured, since the SDK can't see their expiry.
   */
  isAuthenticated(): boolean {
    if (this._status !== "active") return false;
    if (this._expiresAt !== undefined && this._expiresAt <= Date.now()) return false;
    return true;
  }

  snapshot(): SessionSnapshot {
    return { status: this._status, expiresAt: this._expiresAt, identity: this._identity };
  }

  /**
   * Subscribe to session lifecycle events. Returns an unsubscribe function.
   * A throwing listener is isolated — its error is swallowed so one bad host
   * callback can't break the SDK or starve the other listeners.
   */
  onChange(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ─── Mutators (driven by the client, not the host) ──────────────────────

  /** @internal */
  markSignedIn(opts: { expiresAt?: number; identity?: Identity } = {}): void {
    this._status = "active";
    this._expiresAt = opts.expiresAt;
    this._identity = opts.identity;
    this.emit("signedIn");
  }

  /** @internal */
  markRefreshed(opts: { expiresAt?: number; identity?: Identity } = {}): void {
    // `signed_out` is terminal until an explicit markSignedIn. A refresh that
    // resolves AFTER the host signed out (e.g. a coalesced trusted refresh, or
    // any in-flight renewal) must not resurrect the session.
    if (this._status === "signed_out") return;
    this._status = "active";
    this._expiresAt = opts.expiresAt;
    // A refresh keeps the same user; only overwrite identity when supplied so
    // trusted-mode refreshes (which carry no identity) don't wipe it.
    if (opts.identity) this._identity = opts.identity;
    this.emit("refreshed");
  }

  /** @internal */
  markSignedOut(): void {
    this._status = "signed_out";
    this._expiresAt = undefined;
    this._identity = undefined;
    this.emit("signedOut");
  }

  /** @internal */
  markExpired(): void {
    // Only `active` → `expired` is a real transition, and emitting it must be
    // idempotent: a burst of concurrent failed refreshes each routes through
    // onAuthFailure → markExpired, and a signOut may have already ended the
    // session deliberately. Suppressing every non-active origin collapses
    // those to a single `expired` event and never overrides `signed_out`.
    if (this._status !== "active") return;
    this._status = "expired";
    this._expiresAt = undefined;
    this._identity = undefined;
    this.emit("expired");
  }

  /** @internal */
  emitError(error: unknown): void {
    // Once signed out, an in-flight refresh that later fails is irrelevant to
    // the host — don't surface an error for a session they already ended.
    if (this._status === "signed_out") return;
    this.emit("error", error);
  }

  private emit(type: SessionEventType, error?: unknown): void {
    const event: SessionEvent = {
      type,
      session: this.snapshot(),
      ...(type === "error" ? { error } : {}),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A host listener must never break the SDK or the other listeners.
      }
    }
  }
}
