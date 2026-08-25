// Contract + budget tests for the search provider, using the SDK testkit.
// The testkit is framework-agnostic (it returns violation strings rather than
// calling any `expect`), so this file ports to vitest by changing one import.
import { describe, expect, test } from "bun:test";
import {
  HOST_LIMITS,
  benchmark,
  findHitViolations,
  formatBench,
} from "@unifiedai/sdk/app/testkit";
import type { SearchProvider, SearchRequest } from "@unifiedai/sdk/app";
import { createSearchProvider } from "../src/search";

const CONTRACT = {
  limit: HOST_LIMITS.PER_PROVIDER_REQUEST_LIMIT,
  kinds: ["item"],
  // Actions declared with `mutates: false` in public/manifest.json — an
  // `openRef.action` outside this list would be silently stripped by the host.
  nonMutatingActions: ["openItem", "openArtifact"],
};

function request(query: string, overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    query,
    terms: query.toLowerCase().split(/\s+/).filter(Boolean),
    limit: HOST_LIMITS.PER_PROVIDER_REQUEST_LIMIT,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function makeProvider(): Promise<SearchProvider> {
  // The host passes its authenticated SDK instance; this provider never uses it.
  return await createSearchProvider({ sdk: null, appId: "my-app" });
}

describe("search provider contract", () => {
  test("matching query returns contract-clean hits", async () => {
    const provider = await makeProvider();
    const hits = await provider.search(request("notes"));
    expect(hits.length).toBeGreaterThan(0);
    expect(findHitViolations(hits, CONTRACT)).toEqual([]);
  });

  test("empty query is recency mode and stays within the limit", async () => {
    const provider = await makeProvider();
    const hits = await provider.search(request(""));
    expect(hits.length).toBe(HOST_LIMITS.PER_PROVIDER_REQUEST_LIMIT);
    expect(findHitViolations(hits, CONTRACT)).toEqual([]);
  });

  test("respects a smaller request limit", async () => {
    const provider = await makeProvider();
    const hits = await provider.search(request("", { limit: 3 }));
    expect(findHitViolations(hits, { ...CONTRACT, limit: 3 })).toEqual([]);
  });

  test("excluded kinds yield no hits", async () => {
    const provider = await makeProvider();
    expect(await provider.search(request("notes", { kinds: ["doc"] }))).toEqual([]);
  });

  test("hinted-only items surface last", async () => {
    const provider = await makeProvider();
    const hits = await provider.search(
      request("zzz-no-text-match", { hints: { ids: ["my-app:item-4"] } }),
    );
    expect(hits.map((h) => h.id)).toEqual(["item-4"]);
    expect(findHitViolations(hits, CONTRACT)).toEqual([]);
  });

  test("stays far under the per-provider budget", async () => {
    const provider = await makeProvider();
    const stats = await benchmark(() => provider.search(request("plan")));
    console.log(formatBench("my-app/common-term", stats));
    // The host budget (1500ms) includes module load; a template-sized store
    // should not come anywhere near it.
    expect(stats.p95).toBeLessThan(HOST_LIMITS.PER_PROVIDER_TIMEOUT_MS / 10);
  });
});
