// ─────────────────────────────────────────────────────────────────────────────
// testkit — TEST-ONLY companions to the app-search kernel: a hit-contract
// validator and a micro-benchmark runner shared by every app's search suite.
// Import from "@unifiedai/sdk/app/testkit".
//
// A separate entry on purpose: the "./app" barrel maps to the runtime kernel
// exactly, and widening it would risk pulling this file into a shipped
// `search.js` chunk. Framework-agnostic on purpose too: sheets runs vitest
// while the other apps run bun:test, so the validator returns a list of
// violation strings for the caller to assert empty, instead of calling any
// `expect` itself.
// ─────────────────────────────────────────────────────────────────────────────
import { HOST_LIMITS } from "../limits";
import type { AppSearchHit } from "./index";

// Re-exported for back-compat of the testkit surface — the caps now live in
// ../limits so runtime code (a host's fanout, a provider) can import them
// without the test helpers.
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
export function findHitViolations(hits: AppSearchHit[], opts: HitContractOptions = {}): string[] {
  const out: string[] = [];
  const requireSorted = opts.requireSortedByScore !== false;
  if (opts.limit !== undefined && hits.length > opts.limit) {
    out.push(`returned ${hits.length} hits for limit ${opts.limit}`);
  }
  const seen = new Set<string>();
  hits.forEach((hit, i) => {
    const at = `hit[${i}]`;
    const nonEmpty = (field: "id" | "kind" | "title") => {
      const v = hit[field];
      if (typeof v !== "string" || v === "") out.push(`${at}: ${field} must be a non-empty string`);
      return typeof v === "string" ? v : "";
    };
    const id = nonEmpty("id");
    const kind = nonEmpty("kind");
    nonEmpty("title");
    if (kind && kind !== kind.toLowerCase()) out.push(`${at}: kind "${kind}" is not lowercase`);
    if (kind && opts.kinds && !opts.kinds.includes(kind)) {
      out.push(`${at}: kind "${kind}" is not in the manifest's search.kinds`);
    }
    const key = `${kind}:${id}`;
    if (id && seen.has(key)) out.push(`${at}: duplicate hit for ${key}`);
    seen.add(key);
    if (typeof hit.score !== "number" || !Number.isFinite(hit.score)) {
      out.push(`${at}: score must be a finite number`);
    }
    if (hit.updatedAt !== undefined && (!Number.isFinite(hit.updatedAt) || hit.updatedAt <= 0)) {
      out.push(`${at}: updatedAt must be a positive epoch-ms number when present`);
    }
    if (hit.title.length > HOST_LIMITS.TITLE_MAX) {
      out.push(
        `${at}: title (${hit.title.length} chars) exceeds the host cap of ${HOST_LIMITS.TITLE_MAX}`,
      );
    }
    if (hit.snippet !== undefined) {
      if (typeof hit.snippet !== "string" || hit.snippet === "") {
        out.push(`${at}: snippet, when present, must be a non-empty string`);
      } else if (hit.snippet.length > HOST_LIMITS.SNIPPET_MAX) {
        out.push(
          `${at}: snippet (${hit.snippet.length} chars) exceeds the host cap of ${HOST_LIMITS.SNIPPET_MAX}`,
        );
      }
    }
    if (
      hit.containerTitle !== undefined &&
      hit.containerTitle.length > HOST_LIMITS.CONTAINER_TITLE_MAX
    ) {
      out.push(`${at}: containerTitle exceeds the host cap of ${HOST_LIMITS.CONTAINER_TITLE_MAX}`);
    }
    if (hit.preview !== undefined && !opts.allowOversizePreview) {
      const bytes = new TextEncoder().encode(JSON.stringify(hit.preview)).length;
      if (bytes > HOST_LIMITS.PREVIEW_MAX_BYTES) {
        out.push(
          `${at}: preview serializes to ${bytes} bytes; the host silently drops previews over ${HOST_LIMITS.PREVIEW_MAX_BYTES}`,
        );
      }
    }
    if (hit.openRef !== undefined) {
      if (typeof hit.openRef.objectId !== "string" || hit.openRef.objectId === "") {
        out.push(`${at}: openRef.objectId must be a non-empty string`);
      }
      if (hit.openRef.action !== undefined && opts.nonMutatingActions) {
        if (!opts.nonMutatingActions.includes(hit.openRef.action)) {
          out.push(
            `${at}: openRef.action "${hit.openRef.action}" is not a declared non-mutating action — the host's sanitizeOpenRef would silently strip it`,
          );
        }
      }
    }
    const prev = hits[i - 1];
    if (requireSorted && prev !== undefined && hit.score > prev.score) {
      out.push(
        `${at}: score ${hit.score} rises above hit[${i - 1}]'s ${prev.score} — hits must arrive in rank order`,
      );
    }
  });
  return out;
}

// ─── Micro-benchmark ─────────────────────────────────────────────────────────

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
export async function benchmark(
  fn: () => unknown | Promise<unknown>,
  opts: BenchOptions = {},
): Promise<BenchStats> {
  const runs = opts.runs ?? 30;
  const warmup = opts.warmup ?? 5;
  for (let i = 0; i < warmup; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const at = (p: number) =>
    samples[Math.min(samples.length - 1, Math.ceil((p / 100) * samples.length) - 1)] as number;
  return {
    runs,
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50: at(50),
    p95: at(95),
    max: samples[samples.length - 1] as number,
  };
}

/** One legible line for the test log, e.g.
    `search-bench docs/common-term    p50 0.42ms  p95 0.71ms  max 1.90ms  (30 runs)` */
export function formatBench(name: string, s: BenchStats): string {
  const ms = (v: number) => `${v.toFixed(2)}ms`;
  return `search-bench ${name.padEnd(28)} p50 ${ms(s.p50)}  p95 ${ms(s.p95)}  max ${ms(s.max)}  (${s.runs} runs)`;
}
