import type { UnifiedAI } from "../core/client.js";
export interface LocalAgentsConfig {
    /**
     * The client whose credential and API base URL the relay reuses. `client
     * .accessToken()` supplies the WS subprotocol bearer and the `GET /hosts`
     * Authorization header; `client.apiUrl` supplies the base.
     */
    client?: UnifiedAI | undefined;
    /**
     * Absolute unified-api origin+base for the relay WebSocket, when the client
     * is configured RELATIVE (`apiUrl: ""`, i.e. a dev proxy serves `/api/v1/*`).
     *
     * HTTP through a dev proxy is fine, but an upgrade through one is not
     * reliable — the desktop client connects its relay sockets directly to
     * unified-api for exactly this reason. Supply the absolute base here (e.g.
     * `https://api.unifiedai.dev/api/v1`) to do the same. When omitted and the
     * client is relative, the page's own origin is used, which works only if the
     * dev server proxies WebSocket upgrades.
     *
     * Explicitly `undefined` clears a previously configured value, since the
     * merge in `configureLocalAgents` is a spread.
     */
    wsBaseUrl?: string | undefined;
    /** Display label for this surface on the desktop's pairing / approval card. */
    clientName?: string | undefined;
}
/**
 * Point the local-agent module at a configured SDK client. Idempotent; a later
 * call replaces the previous configuration (fields are merged, so passing only
 * `{ client }` keeps a previously set `wsBaseUrl`).
 */
export declare function configureLocalAgents(next: LocalAgentsConfig): void;
export declare function localAgentsConfig(): Readonly<LocalAgentsConfig>;
/** The bearer unified-api accepts from this surface, or null when signed out. */
export declare function unifiedToken(): Promise<string | null>;
/** The base every unified-api HTTP path hangs off (`""` = relative). */
export declare function unifiedApiUrl(): string;
/**
 * The absolute base the relay's `/relay/*` WebSocket paths hang off, resolved
 * in the documented order: explicit `wsBaseUrl` → the client's own absolute
 * `apiUrl` → the page origin (a dev proxy).
 *
 * `Core.apiUrl` is an ORIGIN (`https://api.unifiedai.app`) — the version prefix
 * lives in each path (`/api/v1/models`). The relay is mounted under both
 * `/v1/relay` and `/api/v1/relay`; `/api/v1` is the one a dev proxy already
 * forwards, so it is appended here unless the configured base carries a version
 * segment of its own.
 */
export declare function relayWsBase(): string;
//# sourceMappingURL=config.d.ts.map