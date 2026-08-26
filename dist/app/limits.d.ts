/** Version of the search provider contract these limits belong to. */
export declare const SEARCH_PROTOCOL_VERSION = 1;
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
export declare const HOST_LIMITS: {
    readonly PER_PROVIDER_REQUEST_LIMIT: 10;
    readonly TITLE_MAX: 200;
    readonly SNIPPET_MAX: 300;
    readonly CONTAINER_TITLE_MAX: 120;
    readonly PREVIEW_MAX_BYTES: 2048;
    readonly PER_PROVIDER_TIMEOUT_MS: 1500;
};
//# sourceMappingURL=limits.d.ts.map