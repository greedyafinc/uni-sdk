// Protocol-level limits of the cross-app search fanout — import from
// "@unifiedai/sdk/app".
//
// These are the caps a host applies to every provider's hits (truncating,
// discarding, or timing out past them). They are PROTOCOL CONSTANTS, not
// tunables: a provider is written against exactly these numbers, so a host
// must honor them as stated and may only LOWER one alongside a bump of
// `SEARCH_PROTOCOL_VERSION` — silently tightening a cap strands every
// already-shipped provider on the old contract. A host that wants to advertise
// its live values pushes them through `SearchProviderContext.limits`
// (src/resources/search/types.ts); the constants here are the documented
// defaults a provider may assume when the host pushes nothing.
//
// Moved out of the search testkit so runtime code — a host's fanout, an app's
// provider — can import the numbers without dragging test helpers along. The
// testkit re-exports `HOST_LIMITS` for back-compat of its own surface.

/** Version of the search provider contract these limits belong to. */
export const SEARCH_PROTOCOL_VERSION = 1;

/** The host-side caps a provider's hits are subject to. */
export interface HostLimits {
  /** `limit` the host passes to every provider request. */
  PER_PROVIDER_REQUEST_LIMIT: number;
  /** Beyond these, the host silently truncates the field. */
  TITLE_MAX: number;
  SNIPPET_MAX: number;
  CONTAINER_TITLE_MAX: number;
  /** JSON-serialized `preview` beyond this is silently discarded. */
  PREVIEW_MAX_BYTES: number;
  /** Per-provider budget, INCLUDING module load. Benchmarks assert far under. */
  PER_PROVIDER_TIMEOUT_MS: number;
}

/** The documented default limits for `SEARCH_PROTOCOL_VERSION` 1. */
export const HOST_LIMITS = {
  PER_PROVIDER_REQUEST_LIMIT: 10,
  TITLE_MAX: 200,
  SNIPPET_MAX: 300,
  CONTAINER_TITLE_MAX: 120,
  PREVIEW_MAX_BYTES: 2048,
  PER_PROVIDER_TIMEOUT_MS: 1500,
} as const satisfies HostLimits;
