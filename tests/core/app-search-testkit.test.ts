// The app-search testkit (src/app/search/testkit.ts): the hit-contract
// validator's coverage of each breakage class, and the benchmark runner's
// stats. Also pins the protocol limits (src/app/limits.ts) themselves.
import { describe, expect, it } from "bun:test";

import { HOST_LIMITS as LIMITS_DIRECT, SEARCH_PROTOCOL_VERSION } from "../../src/app/limits";
import type { AppSearchHit } from "../../src/app/search/index";
import {
  HOST_LIMITS,
  benchmark,
  findHitViolations,
  formatBench,
} from "../../src/app/search/testkit";

const hit = (over: Partial<AppSearchHit> = {}): AppSearchHit => ({
  id: "a1",
  kind: "doc",
  title: "Title",
  score: 2,
  updatedAt: 1000,
  ...over,
});

describe("limits", () => {
  it("testkit re-exports the same HOST_LIMITS object the runtime imports", () => {
    expect(HOST_LIMITS).toBe(LIMITS_DIRECT);
  });

  it("pins the protocol-1 values", () => {
    expect(SEARCH_PROTOCOL_VERSION).toBe(1);
    expect(HOST_LIMITS).toEqual({
      PER_PROVIDER_REQUEST_LIMIT: 10,
      TITLE_MAX: 200,
      SNIPPET_MAX: 300,
      CONTAINER_TITLE_MAX: 120,
      PREVIEW_MAX_BYTES: 2048,
      PER_PROVIDER_TIMEOUT_MS: 1500,
    });
  });
});

describe("findHitViolations", () => {
  it("accepts a clean list", () => {
    expect(
      findHitViolations([hit(), hit({ id: "a2", score: 1 })], { limit: 10, kinds: ["doc"] }),
    ).toEqual([]);
  });

  it("flags more hits than the request limit", () => {
    const out = findHitViolations([hit(), hit({ id: "a2" })], { limit: 1 });
    expect(out.some((v) => v.includes("limit 1"))).toBe(true);
  });

  it("flags an empty id", () => {
    const out = findHitViolations([hit({ id: "" })]);
    expect(out.some((v) => v.includes("id must be a non-empty string"))).toBe(true);
  });

  it("flags a non-lowercase kind", () => {
    const out = findHitViolations([hit({ kind: "Doc" })]);
    expect(out.some((v) => v.includes("not lowercase"))).toBe(true);
  });

  it("flags a kind not declared in the manifest", () => {
    const out = findHitViolations([hit({ kind: "sheet" })], { kinds: ["doc"] });
    expect(out.some((v) => v.includes("search.kinds"))).toBe(true);
  });

  it("flags duplicate (kind, id) pairs", () => {
    const out = findHitViolations([hit(), hit({ score: 1 })]);
    expect(out.some((v) => v.includes("duplicate hit for doc:a1"))).toBe(true);
  });

  it("flags an oversize title, snippet and containerTitle", () => {
    const out = findHitViolations([
      hit({
        title: "t".repeat(HOST_LIMITS.TITLE_MAX + 1),
        snippet: "s".repeat(HOST_LIMITS.SNIPPET_MAX + 1),
        containerTitle: "c".repeat(HOST_LIMITS.CONTAINER_TITLE_MAX + 1),
      }),
    ]);
    expect(out.some((v) => v.includes("title"))).toBe(true);
    expect(out.some((v) => v.includes("snippet"))).toBe(true);
    expect(out.some((v) => v.includes("containerTitle"))).toBe(true);
  });

  it("flags a preview that serializes past the byte cap — unless opted out", () => {
    const fat = hit({ preview: { kind: "text", data: "x".repeat(HOST_LIMITS.PREVIEW_MAX_BYTES) } });
    expect(findHitViolations([fat]).some((v) => v.includes("silently drops previews"))).toBe(true);
    expect(findHitViolations([fat], { allowOversizePreview: true })).toEqual([]);
  });

  it("flags an undeclared openRef.action", () => {
    const out = findHitViolations([hit({ openRef: { objectId: "a1", action: "doIt" } })], {
      nonMutatingActions: ["openDocument"],
    });
    expect(out.some((v) => v.includes('openRef.action "doIt"'))).toBe(true);
  });

  it("flags a score rising mid-list, and allows opting out for ordinal scores", () => {
    const unsorted = [hit({ score: 1 }), hit({ id: "a2", score: 5 })];
    expect(findHitViolations(unsorted).some((v) => v.includes("rank order"))).toBe(true);
    expect(findHitViolations(unsorted, { requireSortedByScore: false })).toEqual([]);
  });

  it("flags a non-finite score and a non-positive updatedAt", () => {
    const out = findHitViolations([hit({ score: Number.NaN, updatedAt: 0 })]);
    expect(out.some((v) => v.includes("finite number"))).toBe(true);
    expect(out.some((v) => v.includes("updatedAt"))).toBe(true);
  });
});

describe("benchmark", () => {
  it("returns sane, ordered stats over the requested runs", async () => {
    const stats = await benchmark(() => new Promise((r) => setTimeout(r, 1)), {
      runs: 5,
      warmup: 1,
    });
    expect(stats.runs).toBe(5);
    expect(stats.mean).toBeGreaterThan(0);
    expect(stats.p50).toBeGreaterThan(0);
    expect(stats.p50).toBeLessThanOrEqual(stats.p95);
    expect(stats.p95).toBeLessThanOrEqual(stats.max);
  });

  it("formatBench renders one legible line", async () => {
    const line = formatBench("docs/common-term", {
      runs: 30,
      mean: 0.5,
      p50: 0.42,
      p95: 0.71,
      max: 1.9,
    });
    expect(line).toContain("search-bench docs/common-term");
    expect(line).toContain("p50 0.42ms");
    expect(line).toContain("(30 runs)");
  });
});
