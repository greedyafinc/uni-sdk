// How the local-agent module gets its unified-api credential and base URL.
//
// The relay half (agent-relay.md) is an ordinary unified-api surface: `GET
// /api/v1/relay/hosts` over HTTP and a WebSocket whose bearer rides the
// `Sec-WebSocket-Protocol` value. Both need the SAME credential the caller's
// `UnifiedAI` already sends — a `uapi_` key, an OAuth access token, an internal
// JWT — so this module never reads env vars or invents a second auth path. The
// host wires its client in once with `configureLocalAgents({ client })` and the
// relay reads through it.
//
// The loopback bridge half needs none of this: it is authenticated by its own
// pairing token and works signed-out.

import type { UnifiedAI } from "../core/client";

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

let config: LocalAgentsConfig = {};

/**
 * Point the local-agent module at a configured SDK client. Idempotent; a later
 * call replaces the previous configuration (fields are merged, so passing only
 * `{ client }` keeps a previously set `wsBaseUrl`).
 */
export function configureLocalAgents(next: LocalAgentsConfig): void {
  config = { ...config, ...next };
}

export function localAgentsConfig(): Readonly<LocalAgentsConfig> {
  return config;
}

/** The bearer unified-api accepts from this surface, or null when signed out. */
export async function unifiedToken(): Promise<string | null> {
  const client = config.client;
  if (!client) return null;
  try {
    const token = await client.accessToken();
    return token || null;
  } catch {
    // No token configured / OAuth unavailable — "no relay", not an error the
    // caller has to handle: source selection simply finds no hosts.
    return null;
  }
}

/** The base every unified-api HTTP path hangs off (`""` = relative). */
export function unifiedApiUrl(): string {
  return config.client?.apiUrl ?? "";
}

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
export function relayWsBase(): string {
  const explicit = config.wsBaseUrl?.trim();
  if (explicit) return withApiPrefix(explicit);
  const api = unifiedApiUrl().trim();
  if (api && /^https?:\/\//i.test(api)) return withApiPrefix(api);
  const origin = typeof location !== "undefined" ? location.origin : "http://localhost";
  return `${origin}/api/v1`;
}

function withApiPrefix(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}
