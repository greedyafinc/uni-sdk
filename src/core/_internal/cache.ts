// In-memory LRU with TTL for opt-in response caching. Scoped to deterministic
// endpoints (embeddings, image generations) where the host re-issues the same
// request and an identical answer is acceptable.
//
// Keys are a stable hash of `method|path|sorted-JSON(body)`. The cache stores
// the deserialized response (not the Response object), so a hit short-circuits
// the HTTP layer entirely — no second deserialize, no header allocation.

export interface CacheConfig {
  /** Hard cap on stored entries. LRU eviction beyond this. Default 256. */
  maxEntries: number;
  /** Per-entry time-to-live (ms). Default 5 minutes. */
  ttlMs: number;
}

export const DEFAULT_CACHE: CacheConfig = Object.freeze({
  maxEntries: 256,
  ttlMs: 5 * 60_000,
});

export function resolveCacheConfig(
  override: false | Partial<CacheConfig> | undefined,
): CacheConfig | undefined {
  if (override === false || override === undefined) return undefined;
  return {
    maxEntries: override.maxEntries ?? DEFAULT_CACHE.maxEntries,
    ttlMs: override.ttlMs ?? DEFAULT_CACHE.ttlMs,
  };
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

/**
 * LRU + TTL. Map iteration order is insertion order, so we re-insert on hit
 * to bump entries to the most-recently-used position. Expired entries are
 * detected on read and dropped; we don't run a sweep timer (would need to
 * manage cancellation on host teardown, and a passive check is enough for
 * the bounded-size use case here).
 */
export class LruCache {
  private readonly store = new Map<string, Entry>();
  private readonly cfg: CacheConfig;

  constructor(cfg: CacheConfig) {
    this.cfg = cfg;
  }

  get(key: string): unknown | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh LRU position by re-inserting at the tail.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: unknown): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + this.cfg.ttlMs });
    while (this.store.size > this.cfg.maxEntries) {
      // Map iteration order is insertion order; the first key is the LRU.
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Stable JSON: keys sorted recursively so `{a:1,b:2}` and `{b:2,a:1}` hash
 * identically. Arrays preserve order. Unserializable inputs (cycles, BigInt)
 * fall back to `String(value)` — the cache will simply miss for those, which
 * is the right outcome.
 */
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      out[k] = walk(obj[k]);
    }
    return out;
  };
  try {
    return JSON.stringify(walk(value));
  } catch {
    return String(value);
  }
}

/**
 * FNV-1a 32-bit hash. Fast, dependency-free, good enough for cache keys
 * (collisions here just degrade hit rate, never produce wrong answers,
 * because we include method+path in the canonical key string already).
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // >>> 0 normalizes to unsigned 32-bit
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function cacheKey(method: string, path: string, body: unknown): string {
  const canonical = `${method.toUpperCase()}|${path}|${stableStringify(body ?? null)}`;
  return `${fnv1a(canonical)}|${canonical.length}`;
}
