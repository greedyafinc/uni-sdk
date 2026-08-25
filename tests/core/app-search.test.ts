// The search-provider kernel (src/app/search/index.ts): term matching, the
// weight table, the hints floor, the searchText pushdown, the capability
// latch, hit projection, and the shared tie-break.
import { describe, expect, it } from "bun:test";

import {
  HINTS_FLOOR,
  type SearchTextCollection,
  compareHits,
  createLatchedFallback,
  isHinted,
  matchKind,
  queryBySearchText,
  scoreFields,
  toSearchHit,
} from "../../src/app/search/index";

describe("matchKind", () => {
  it("matches at the start of the string as boundary", () => {
    expect(matchKind("quarterly report", "quart")).toBe("boundary");
  });

  it("matches after whitespace or punctuation as boundary", () => {
    expect(matchKind("q3 report", "report")).toBe("boundary");
    expect(matchKind("plan-b", "b")).toBe("boundary");
  });

  it("classifies a mid-word-only occurrence as mid", () => {
    expect(matchKind("preport", "report")).toBe("mid");
  });

  it("prefers a later boundary hit over an earlier mid-word one", () => {
    expect(matchKind("xreport report", "report")).toBe("boundary");
  });

  it("returns none for a miss and for the empty term", () => {
    expect(matchKind("anything", "zzz")).toBe("none");
    expect(matchKind("anything", "")).toBe("none");
  });
});

describe("scoreFields", () => {
  it("applies the weight table per field", () => {
    // "beta" boundary in title (+3), boundary in secondary (+1), boundary in
    // body (+0.75), plus all-terms-in-title (+2).
    expect(scoreFields({ title: "beta", secondary: "beta", body: "beta" }, ["beta"], "x")).toBe(
      3 + 1 + 0.75 + 2 + 0, // no exact-title bonus: query is "x"
    );
  });

  it("halves (or thirds) mid-word matches", () => {
    expect(scoreFields({ title: "xbeta" }, ["beta"], "q")).toBe(1.5 + 2);
    expect(scoreFields({ title: "z", secondary: "xbeta" }, ["beta"], "q")).toBe(0.5);
    expect(scoreFields({ title: "z", body: "xbeta" }, ["beta"], "q")).toBe(0.25);
  });

  it("adds +2 only when ALL terms appear in the title", () => {
    const both = scoreFields({ title: "alpha beta" }, ["alpha", "beta"], "q");
    expect(both).toBe(3 + 3 + 2);
    const one = scoreFields({ title: "alpha only" }, ["alpha", "beta"], "q");
    expect(one).toBe(3);
  });

  it("adds +5 for a case-folded exact title match", () => {
    expect(scoreFields({ title: "Budget" }, ["budget"], "BUDGET")).toBe(3 + 2 + 5);
  });

  it("scores 0 with no terms (no spurious all-in-title bonus)", () => {
    expect(scoreFields({ title: "anything" }, [], "q")).toBe(0);
  });
});

describe("HINTS_FLOOR", () => {
  it("sits strictly between 0 and the weakest real match (0.25)", () => {
    expect(HINTS_FLOOR).toBe(0.1);
    expect(HINTS_FLOOR).toBeGreaterThan(0);
    expect(HINTS_FLOOR).toBeLessThan(0.25);
  });
});

describe("isHinted", () => {
  it("matches a bare id and a namespaced handle", () => {
    expect(isHinted("abc", ["abc"], "sheets")).toBe(true);
    expect(isHinted("abc", ["sheets:abc"], "sheets")).toBe(true);
  });

  it("rejects another app's namespace and empty/missing hints", () => {
    expect(isHinted("abc", ["docs:abc"], "sheets")).toBe(false);
    expect(isHinted("abc", [], "sheets")).toBe(false);
    expect(isHinted("abc", undefined, "sheets")).toBe(false);
  });
});

describe("queryBySearchText", () => {
  it("returns [] for a missing collection without touching the server", async () => {
    expect(await queryBySearchText(null, "x", 5)).toEqual([]);
    expect(await queryBySearchText(undefined, "x", 5)).toEqual([]);
  });

  it("issues the match query with recency order and the limit", async () => {
    let captured: unknown;
    const collection: SearchTextCollection<{ id: string }> = {
      query: async (q) => {
        captured = q;
        return [{ id: "r1" }];
      },
    };
    expect(await queryBySearchText(collection, "hello world", 7)).toEqual([{ id: "r1" }]);
    expect(captured).toEqual({
      where: { searchText: { match: "hello world" } },
      orderBy: "updatedAt",
      order: "desc",
      limit: 7,
    });
  });

  it("propagates a server failure (the latch depends on it)", async () => {
    const collection: SearchTextCollection<never> = {
      query: async () => {
        throw new Error("op unsupported");
      },
    };
    await expect(queryBySearchText(collection, "x", 1)).rejects.toThrow("op unsupported");
  });
});

describe("createLatchedFallback", () => {
  const silenced = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = console.warn;
    console.warn = () => {};
    try {
      return await fn();
    } finally {
      console.warn = original;
    }
  };

  it("passes results through while the capability works", async () => {
    const latch = createLatchedFallback("t", async () => [1, 2]);
    expect(await latch.run("q", 5)).toEqual([1, 2]);
    expect(latch.disabled).toBe(false);
  });

  it("latches off after the first failure and never retries", async () => {
    let calls = 0;
    const latch = createLatchedFallback("t", async () => {
      calls++;
      throw new Error("no such op");
    });
    expect(await silenced(() => latch.run("q", 5))).toEqual([]);
    expect(latch.disabled).toBe(true);
    expect(await latch.run("q", 5)).toEqual([]);
    expect(calls).toBe(1);
  });

  it("skips the attempt entirely on an already-aborted signal", async () => {
    let calls = 0;
    const latch = createLatchedFallback("t", async () => {
      calls++;
      return [1];
    });
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await latch.run("q", 5, ctrl.signal)).toEqual([]);
    expect(calls).toBe(0);
    expect(latch.disabled).toBe(false);
  });

  it("resetForTests re-arms the capability", async () => {
    let fail = true;
    const latch = createLatchedFallback("t", async () => {
      if (fail) throw new Error("down");
      return [9];
    });
    await silenced(() => latch.run("q", 1));
    expect(latch.disabled).toBe(true);
    latch.resetForTests();
    fail = false;
    expect(await latch.run("q", 1)).toEqual([9]);
  });
});

describe("toSearchHit", () => {
  const base = {
    id: "d1",
    kind: "doc",
    title: "T",
    score: 3,
    updatedAt: 1000,
    openRef: { objectId: "d1" },
  };

  it("omits absent optional fields rather than emitting undefined keys", () => {
    const hit = toSearchHit(base);
    expect(hit).toEqual({
      id: "d1",
      kind: "doc",
      title: "T",
      score: 3,
      updatedAt: 1000,
      openRef: { objectId: "d1" },
    });
    expect(Object.keys(hit)).not.toContain("snippet");
    expect(Object.keys(hit)).not.toContain("preview");
    expect(Object.keys(hit)).not.toContain("projectId");
  });

  it("an empty excerpt is not a snippet", () => {
    expect(Object.keys(toSearchHit({ ...base, text: "" }))).not.toContain("snippet");
  });

  it("textPreview emits the excerpt as both snippet and preview.data", () => {
    const hit = toSearchHit({ ...base, text: "excerpt", textPreview: true });
    expect(hit.snippet).toBe("excerpt");
    expect(hit.preview).toEqual({ kind: "text", data: "excerpt" });
  });

  it("a null projectId still travels (only undefined is omitted)", () => {
    const hit = toSearchHit({ ...base, projectId: null });
    expect(hit.projectId).toBeNull();
    expect("projectId" in hit).toBe(true);
  });
});

describe("compareHits", () => {
  it("orders by score desc, then updatedAt desc", () => {
    const rows = [
      { score: 1, row: { updatedAt: 5 } },
      { score: 3, row: { updatedAt: 1 } },
      { score: 3, row: { updatedAt: 9 } },
    ];
    const sorted = [...rows].sort(compareHits((c) => c.row.updatedAt));
    expect(sorted.map((c) => [c.score, c.row.updatedAt])).toEqual([
      [3, 9],
      [3, 1],
      [1, 5],
    ]);
  });
});
