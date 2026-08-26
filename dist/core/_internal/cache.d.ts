export interface CacheConfig {
    /** Hard cap on stored entries. LRU eviction beyond this. Default 256. */
    maxEntries: number;
    /** Per-entry time-to-live (ms). Default 5 minutes. */
    ttlMs: number;
}
export declare const DEFAULT_CACHE: CacheConfig;
export declare function resolveCacheConfig(override: false | Partial<CacheConfig> | undefined): CacheConfig | undefined;
/**
 * LRU + TTL. Map iteration order is insertion order, so we re-insert on hit
 * to bump entries to the most-recently-used position. Expired entries are
 * detected on read and dropped; we don't run a sweep timer (would need to
 * manage cancellation on host teardown, and a passive check is enough for
 * the bounded-size use case here).
 */
export declare class LruCache {
    private readonly store;
    private readonly cfg;
    constructor(cfg: CacheConfig);
    get(key: string): unknown | undefined;
    set(key: string, value: unknown): void;
    clear(): void;
    get size(): number;
}
export declare function cacheKey(method: string, path: string, body: unknown, query?: unknown): string;
//# sourceMappingURL=cache.d.ts.map