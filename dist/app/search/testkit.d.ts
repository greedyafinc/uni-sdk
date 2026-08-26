import { HOST_LIMITS } from "../limits.js";
import type { AppSearchHit } from "./index.js";
export { HOST_LIMITS };
export interface HitContractOptions {
    /** The `limit` the request carried; hits beyond it are a violation. */
    limit?: number;
    /** The app's manifest `search.kinds`; a hit of any other kind is a violation. */
    kinds?: string[];
    /** Declared actions with `mutates: false`. An `openRef.action` outside this
        list would be silently stripped by the host's sanitizeOpenRef. */
    nonMutatingActions?: string[];
    /** Providers return hits in rank order (the host fuses by RANK, not score),
        so a score increase mid-list almost always means a missing sort. Opt out
        only for a provider whose scores are ordinals from a delegated matcher. */
    requireSortedByScore?: boolean;
    /** For a provider that deliberately exceeds PREVIEW_MAX_BYTES and relies on
        the host discarding the preview. */
    allowOversizePreview?: boolean;
}
/**
 * Every way `hits` breaks the provider contract or would be silently mangled
 * by the host's sanitizeHit, as human-readable strings. Meant for
 * `expect(findHitViolations(hits, opts)).toEqual([])` — a failure then prints
 * the precise breakage instead of a diff of two hit arrays.
 *
 * Silent host truncation is treated as a violation on purpose: the suites run
 * against CONTROLLED fixtures, so an oversize field here is the provider
 * choosing to ship data the user will never see.
 */
export declare function findHitViolations(hits: AppSearchHit[], opts?: HitContractOptions): string[];
export interface BenchStats {
    runs: number;
    /** Milliseconds. */
    mean: number;
    p50: number;
    p95: number;
    max: number;
}
export interface BenchOptions {
    /** Timed iterations after warmup. */
    runs?: number;
    /** Untimed iterations first, so JIT/lazy-init cost is not billed to p50. */
    warmup?: number;
}
/**
 * Time `fn` and summarize. Each iteration is awaited to completion before the
 * next starts — providers are invoked serially by the host per request, so
 * overlapping runs would measure contention that cannot occur in production.
 */
export declare function benchmark(fn: () => unknown | Promise<unknown>, opts?: BenchOptions): Promise<BenchStats>;
/** One legible line for the test log, e.g.
    `search-bench docs/common-term    p50 0.42ms  p95 0.71ms  max 1.90ms  (30 runs)` */
export declare function formatBench(name: string, s: BenchStats): string;
//# sourceMappingURL=testkit.d.ts.map