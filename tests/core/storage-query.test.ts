// `sdk.storage` query surface: operator predicates over the server's
// pushed-down `/query-v2` endpoint.
//
// Three layers, because each catches a different class of bug:
//   1. WIRE SHAPE — what CloudStorageBackend actually POSTs. This is the
//      contract with unified-api's queryV2.ts; it is the only thing we can
//      verify offline, so it is asserted operator by operator.
//   2. SEMANTICS — what a predicate means, asserted against MemoryBackend,
//      which deliberately mirrors Postgres (not JS) semantics.
//   3. CONFORMANCE — the same behavioural suite run through BOTH backends,
//      the cloud one wired to a fake server that speaks the real wire shapes.
//      A divergence between the two backends fails here rather than in prod.
import { describe, expect, test } from "bun:test";
import { UnifiedAI } from "../../src/core/client";
import { UnifiedError } from "../../src/core/errors";
import { CloudStorageBackend, MemoryBackend } from "../../src/resources/storage";
import type { BackendQuery, Collection, StorageBackend } from "../../src/resources/storage";

interface Task extends Record<string, unknown> {
  id: string;
  status: string;
  rank: number;
  searchText: string;
  owner?: string | null;
}

const SEED: Task[] = [
  { id: "t1", status: "todo", rank: 2, searchText: "write the quarterly report", owner: "ada" },
  { id: "t2", status: "done", rank: 10, searchText: "ship the report to finance", owner: "bob" },
  { id: "t3", status: "todo", rank: 9, searchText: "review pull requests" },
  { id: "t4", status: "blocked", rank: 1, searchText: "quarterly planning offsite", owner: "ada" },
];

const SCHEMA = {
  key: "id",
  indexes: ["status", "rank"],
  fieldTypes: { rank: "number" },
} as const;

// ─── Test doubles ────────────────────────────────────────────────────────────

/** Captures every storage POST and answers with a canned empty page. */
function capturing(): {
  calls: Array<{ path: string; body: Record<string, unknown> }>;
  tasks: Collection<Task>;
} {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ records: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const sdk = new UnifiedAI({
    apiUrl: "https://example.test",
    fetch: fakeFetch,
    token: "t",
    appId: "tasks",
  });
  return { calls, tasks: sdk.storage.namespace().collection<Task>("tasks", SCHEMA) };
}

/** The last `/query-v2` body's `query` object. */
function lastQuery(calls: Array<{ path: string; body: Record<string, unknown> }>): BackendQuery {
  const hit = [...calls].reverse().find((c) => c.path.endsWith("/query-v2"));
  if (!hit) throw new Error(`no /query-v2 call; saw ${calls.map((c) => c.path).join(", ")}`);
  return (hit.body.query ?? {}) as BackendQuery;
}

/**
 * A fake unified-api whose storage routes are backed by a MemoryBackend. This
 * makes the cloud backend exercise the REAL wire encoding (JSON round trip,
 * `{records,nextCursor}` envelope, cursor strings) while still being runnable
 * offline — so the conformance suite genuinely compares two code paths.
 */
function fakeServer(): Collection<Task> {
  const store = new MemoryBackend();
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace("/api/v1/storage", "");
    const b = JSON.parse(String(init?.body ?? "{}"));
    const ok = (v: unknown) =>
      new Response(JSON.stringify(v), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    switch (path) {
      case "/put":
        return ok(
          await store.put({
            ns: b.ns,
            collection: b.collection,
            id: b.id,
            metadata: b.metadata,
            versioned: b.versioned,
          }),
        );
      case "/query-v2":
        return ok(await store.query(b.ns, b.collection, b.query ?? {}));
      case "/count-v2": {
        const q = (b.query ?? {}) as BackendQuery;
        if (q.limit !== undefined || q.after !== undefined) {
          return new Response(
            JSON.stringify({
              code: "unsupported_query",
              message: "count does not accept limit/after",
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return ok({ count: await store.count(b.ns, b.collection, q) });
      }
      case "/get":
        return ok({ record: await store.get(b.ns, b.collection, b.id) });
      default:
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }
  }) as unknown as typeof fetch;
  const sdk = new UnifiedAI({
    apiUrl: "https://example.test",
    fetch: fakeFetch,
    token: "t",
    appId: "tasks",
  });
  return sdk.storage.namespace().collection<Task>("tasks", SCHEMA);
}

function memoryCollection(): Collection<Task> {
  const sdk = new UnifiedAI({ appId: "tasks", storage: new MemoryBackend() });
  return sdk.storage.namespace().collection<Task>("tasks", SCHEMA);
}

async function seeded(make: () => Collection<Task>): Promise<Collection<Task>> {
  const c = make();
  for (const row of SEED) await c.put(row);
  return c;
}

const ids = (rows: Task[]): string[] => rows.map((r) => r.id);

// ─── 1. Wire shape ───────────────────────────────────────────────────────────

describe("storage query → /query-v2 wire shape", () => {
  test("posts to /query-v2, never the JS-filtered legacy /query", async () => {
    const { calls, tasks } = capturing();
    await tasks.query({ where: { status: "todo" } });
    expect(calls.map((c) => c.path)).toContain("/api/v1/storage/query-v2");
    expect(calls.some((c) => c.path.endsWith("/storage/query"))).toBe(false);
  });

  test("a bare value is equality shorthand", async () => {
    const { calls, tasks } = capturing();
    await tasks.query({ where: { status: "todo" } });
    expect(lastQuery(calls).where).toEqual([{ field: "status", op: "eq", value: "todo" }]);
  });

  test("every operator lowers to its wire clause", async () => {
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{ status: { eq: "todo" } }, [{ field: "status", op: "eq", value: "todo" }]],
      [{ status: { neq: "done" } }, [{ field: "status", op: "neq", value: "done" }]],
      [
        { status: { in: ["todo", "done"] } },
        [{ field: "status", op: "in", value: ["todo", "done"] }],
      ],
      [{ rank: { gt: 3 } }, [{ field: "rank", op: "gt", value: 3, type: "number" }]],
      [{ rank: { gte: 3 } }, [{ field: "rank", op: "gte", value: 3, type: "number" }]],
      [{ rank: { lt: 3 } }, [{ field: "rank", op: "lt", value: 3, type: "number" }]],
      [{ rank: { lte: 3 } }, [{ field: "rank", op: "lte", value: 3, type: "number" }]],
      [{ owner: { exists: true } }, [{ field: "owner", op: "exists", value: true }]],
      [
        { searchText: { match: "report" } },
        [{ field: "searchText", op: "match", value: "report" }],
      ],
    ];
    for (const [where, expected] of cases) {
      const { calls, tasks } = capturing();
      await tasks.query({ where: where as never });
      expect(lastQuery(calls).where).toEqual(expected as never);
    }
  });

  test("range ops infer text vs number from the operand, not a declaration", async () => {
    const { calls, tasks } = capturing();
    await tasks.query({ where: { rank: { gt: 3 }, status: { gt: "a" } } as never });
    expect(lastQuery(calls).where).toEqual([
      { field: "rank", op: "gt", value: 3, type: "number" },
      { field: "status", op: "gt", value: "a", type: "text" },
    ]);
  });

  test("multiple operators on one field become ANDed clauses (a closed range)", async () => {
    const { calls, tasks } = capturing();
    await tasks.query({ where: { rank: { gte: 2, lte: 9 } } as never });
    expect(lastQuery(calls).where).toEqual([
      { field: "rank", op: "gte", value: 2, type: "number" },
      { field: "rank", op: "lte", value: 9, type: "number" },
    ]);
  });

  test("eq/neq/in carry no `type` — the server compares them as text", async () => {
    const { calls, tasks } = capturing();
    await tasks.query({ where: { rank: 10 } as never });
    expect(lastQuery(calls).where).toEqual([{ field: "rank", op: "eq", value: 10 }]);
  });

  test("orderBy picks the JSON path from the declared field type", async () => {
    const { calls: a, tasks: numeric } = capturing();
    await numeric.query({ orderBy: "rank", order: "desc" });
    expect(lastQuery(a).orderBy).toEqual({ field: "rank", type: "number", dir: "desc" });

    const { calls: b, tasks: text } = capturing();
    await text.query({ orderBy: "status" });
    expect(lastQuery(b).orderBy).toEqual({ field: "status", type: "text", dir: "asc" });
  });

  test("the object orderBy form overrides the declared type", async () => {
    const { calls, tasks } = capturing();
    await tasks.query({ orderBy: { field: "rank", type: "text", dir: "desc" } });
    expect(lastQuery(calls).orderBy).toEqual({ field: "rank", type: "text", dir: "desc" });
  });

  test("`after` is forwarded and `offset` no longer exists on the wire", async () => {
    const { calls, tasks } = capturing();
    await tasks.query({ after: "CURSOR", limit: 5 });
    const q = lastQuery(calls) as BackendQuery & { offset?: number; order?: string };
    expect(q.after).toBe("CURSOR");
    expect(q.limit).toBe(5);
    expect(q.offset).toBeUndefined();
    expect(q.order).toBeUndefined();
  });

  test("an unbounded query asks for the server's max page, not the default 100", async () => {
    const { calls, tasks } = capturing();
    await tasks.query({});
    expect(lastQuery(calls).limit).toBe(1000);
  });

  test("count() posts a single /count-v2 request — not /query-v2, not the legacy /count", async () => {
    const { calls, tasks } = capturing();
    await tasks.count({ where: { rank: { gte: 5 } } as never });
    // Exactly one HTTP call for the whole operation — the point of count-v2
    // over the old cursor-walk is that counting is O(1) requests, not O(rows).
    expect(calls.length).toBe(1);
    expect(calls[0]?.path).toBe("/api/v1/storage/count-v2");
    const body = calls[0]?.body as { query?: BackendQuery };
    expect(body.query?.where).toEqual([{ field: "rank", op: "gte", value: 5, type: "number" }]);
    expect(body.query?.limit).toBeUndefined();
    expect(body.query?.after).toBeUndefined();
  });

  test("CloudStorageBackend.count() strips limit/after before they reach the wire", async () => {
    // The Collection-level count() never sets limit/after on the query it
    // hands the backend, but the backend guards independently: count-v2
    // rejects them with a 400, so anyone calling the backend directly (or a
    // future call site) must not be able to leak them onto the wire.
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ count: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "t",
      appId: "tasks",
    });
    const backend = new CloudStorageBackend(sdk);
    await backend.count("ns1", "tasks", {
      where: [{ field: "status", op: "eq", value: "todo" }],
      limit: 1000,
      after: "SOME_CURSOR",
    } as BackendQuery);
    expect(calls.length).toBe(1);
    expect(calls[0]?.path).toBe("/api/v1/storage/count-v2");
    expect(calls[0]?.body.query).toEqual({
      where: [{ field: "status", op: "eq", value: "todo" }],
    });
  });
});

// ─── 2. Client-side guards ───────────────────────────────────────────────────

describe("storage query guards", () => {
  test("`match` is rejected on any field but searchText", async () => {
    const { tasks } = capturing();
    await expect(tasks.query({ where: { status: { match: "todo" } } as never })).rejects.toThrow(
      /only works on "searchText"/,
    );
  });

  test("`in` beyond the server's 50-item cap fails client-side with a clear message", async () => {
    const { tasks } = capturing();
    const many = Array.from({ length: 51 }, (_, i) => `s${i}`);
    await expect(tasks.query({ where: { status: { in: many } } as never })).rejects.toThrow(
      /51 items \(max 50\)/,
    );
  });

  test("`exists` demands a boolean and `in` demands an array", async () => {
    const { tasks } = capturing();
    await expect(tasks.query({ where: { owner: { exists: "yes" } } as never })).rejects.toThrow(
      /exists needs a boolean/,
    );
    await expect(tasks.query({ where: { status: { in: "todo" } } as never })).rejects.toThrow(
      /in needs an array/,
    );
  });

  test("a mistyped operator names itself instead of silently matching nothing", async () => {
    const { tasks } = capturing();
    await expect(tasks.query({ where: { owner: { gte: 1, ltee: 5 } } as never })).rejects.toThrow(
      /unknown operator\(s\): ltee/,
    );
  });

  test("an object-valued field is still usable as an equality shorthand only if scalar", async () => {
    const { tasks } = capturing();
    // No key is an operator → equality shorthand → but an object can never be
    // compared server-side, so it fails loudly rather than matching nothing.
    await expect(tasks.query({ where: { owner: { nested: 1 } } as never })).rejects.toThrow(
      /needs a string, number, or boolean/,
    );
  });

  test("blob-field guards still throw invalid_input", async () => {
    interface Art extends Record<string, unknown> {
      id: string;
      html: string;
    }
    const arts = new UnifiedAI({ appId: "a", storage: new MemoryBackend() }).storage
      .namespace()
      .collection<Art>("arts", { key: "id", blob: "html" });
    await arts.put({ id: "a", html: "<p>x</p>" });
    await expect(arts.query({ where: { html: "<p>x</p>" } })).rejects.toThrow(/blob field/);
    await expect(arts.query({ where: { html: { exists: true } } as never })).rejects.toThrow(
      /blob field/,
    );
    await expect(arts.query({ orderBy: "html" })).rejects.toThrow(/blob field/);
    await expect(arts.query({ orderBy: { field: "html" } })).rejects.toThrow(/blob field/);
  });
});

// ─── 3. Cross-backend conformance ────────────────────────────────────────────

for (const [label, make] of [
  ["MemoryBackend", memoryCollection],
  ["CloudStorageBackend (over the wire)", fakeServer],
] as const) {
  describe(`storage predicates — ${label}`, () => {
    test("equality shorthand and eq agree", async () => {
      const c = await seeded(make);
      expect(ids(await c.query({ where: { status: "todo" } }))).toEqual(["t1", "t3"]);
      expect(ids(await c.query({ where: { status: { eq: "todo" } } as never }))).toEqual([
        "t1",
        "t3",
      ]);
    });

    test("eq compares as text, so 10 matches a stored number 10", async () => {
      const c = await seeded(make);
      expect(ids(await c.query({ where: { rank: 10 } as never }))).toEqual(["t2"]);
      expect(ids(await c.query({ where: { rank: "10" } as never }))).toEqual(["t2"]);
    });

    test("neq EXCLUDES rows missing the field (SQL three-valued logic)", async () => {
      const c = await seeded(make);
      // t3 has no `owner` at all — it must not surface under `owner != ada`.
      expect(ids(await c.query({ where: { owner: { neq: "ada" } } as never }))).toEqual(["t2"]);
    });

    test("in, and range ops that sort numerically not lexicographically", async () => {
      const c = await seeded(make);
      expect(
        ids(await c.query({ where: { status: { in: ["done", "blocked"] } } as never })).sort(),
      ).toEqual(["t2", "t4"]);
      // The classic trap: as text, "9" > "10". As a number it is not.
      expect(ids(await c.query({ where: { rank: { gt: 9 } } as never }))).toEqual(["t2"]);
      expect(ids(await c.query({ where: { rank: { gte: 2, lte: 9 } } as never })).sort()).toEqual([
        "t1",
        "t3",
      ]);
    });

    test("exists distinguishes present from absent", async () => {
      const c = await seeded(make);
      expect(ids(await c.query({ where: { owner: { exists: true } } as never })).sort()).toEqual([
        "t1",
        "t2",
        "t4",
      ]);
      expect(ids(await c.query({ where: { owner: { exists: false } } as never }))).toEqual(["t3"]);
    });

    test("a null value means `has no value` — the old silent-empty bug", async () => {
      const c = await seeded(make);
      // Before: the server strips nulls on write, so equality against null
      // could never match and this returned [] with no explanation.
      expect(ids(await c.query({ where: { owner: null } as never }))).toEqual(["t3"]);
      // Writing an explicit null is the same as omitting the field.
      await c.put({ id: "t5", status: "todo", rank: 5, searchText: "x", owner: null });
      expect(await c.get("t5")).toEqual({
        id: "t5",
        status: "todo",
        rank: 5,
        searchText: "x",
      } as Task);
      expect(ids(await c.query({ where: { owner: null } as never })).sort()).toEqual(["t3", "t5"]);
    });

    test("match is a whole-token full-text search on searchText", async () => {
      const c = await seeded(make);
      expect(
        ids(await c.query({ where: { searchText: { match: "report" } } as never })).sort(),
      ).toEqual(["t1", "t2"]);
      // Terms are ANDed.
      expect(
        ids(await c.query({ where: { searchText: { match: "quarterly report" } } as never })),
      ).toEqual(["t1"]);
      // Quoted phrase must be contiguous; `-` excludes.
      expect(
        ids(await c.query({ where: { searchText: { match: '"quarterly planning"' } } as never })),
      ).toEqual(["t4"]);
      expect(
        ids(await c.query({ where: { searchText: { match: "report -finance" } } as never })),
      ).toEqual(["t1"]);
    });

    test("numeric orderBy sorts numerically; text orderBy sorts lexicographically", async () => {
      const c = await seeded(make);
      expect(ids(await c.query({ orderBy: "rank", order: "asc" }))).toEqual([
        "t4",
        "t1",
        "t3",
        "t2",
      ]);
      // Forcing the text cast reproduces the "10 before 9" trap on purpose.
      expect(ids(await c.query({ orderBy: { field: "rank", type: "text", dir: "asc" } }))).toEqual([
        "t4",
        "t2",
        "t1",
        "t3",
      ]);
    });

    test("ordering is stable: id ascending is always the tiebreak", async () => {
      const c = make();
      for (const id of ["b", "a", "c"]) {
        await c.put({ id, status: "todo", rank: 1, searchText: "" });
      }
      expect(ids(await c.query({ orderBy: "rank" }))).toEqual(["a", "b", "c"]);
      expect(ids(await c.query({}))).toEqual(["a", "b", "c"]);
    });

    test("page() round-trips the keyset cursor and covers every row exactly once", async () => {
      const c = make();
      for (let i = 0; i < 25; i++) {
        await c.put({
          id: `t${String(i).padStart(2, "0")}`,
          status: "todo",
          rank: i,
          searchText: "",
        });
      }
      const seen: string[] = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const p = await c.page({ orderBy: "rank", limit: 10, ...(after ? { after } : {}) });
        seen.push(...ids(p.items));
        after = p.nextCursor;
        pages++;
      } while (after && pages < 10);
      expect(pages).toBe(3);
      expect(seen.length).toBe(25);
      expect(new Set(seen).size).toBe(25);
      expect(seen).toEqual(ids(await c.query({ orderBy: "rank" })));
    });

    test("query() follows the cursor: no silent truncation at the page size", async () => {
      const c = make();
      // > the backend's default page (100) and > one max page (1000).
      for (let i = 0; i < 1200; i++) {
        await c.put({
          id: `t${String(i).padStart(4, "0")}`,
          status: "todo",
          rank: i,
          searchText: "",
        });
      }
      const all = await c.query({ orderBy: "rank" });
      expect(all.length).toBe(1200);
      expect(all[0]?.id).toBe("t0000");
      expect(all[1199]?.id).toBe("t1199");
      // An explicit limit still caps exactly, including above one page.
      expect((await c.query({ orderBy: "rank", limit: 1050 })).length).toBe(1050);
      expect((await c.query({ orderBy: "rank", limit: 3 })).length).toBe(3);
      expect(await c.count()).toBe(1200);
    });

    test("rows missing the order field sort LAST ascending (Postgres NULLS LAST)", async () => {
      const c = make();
      await c.put({ id: "a", status: "todo", rank: 5, searchText: "", owner: "ada" });
      await c.put({ id: "b", status: "todo", rank: 5, searchText: "" }); // no owner
      await c.put({ id: "c", status: "todo", rank: 5, searchText: "", owner: "zoe" });
      expect(ids(await c.query({ orderBy: "owner", order: "asc" }))).toEqual(["a", "c", "b"]);
      expect(ids(await c.query({ orderBy: "owner", order: "desc" }))).toEqual(["b", "c", "a"]);
    });

    /**
     * Full keyset walk of `orderBy: "owner"` (limit 2, so every page boundary
     * gets exercised), collecting every id visited. Used below to assert
     * TOTALITY: a walk in either direction must visit every matching row
     * exactly once and terminate, regardless of how sparse `owner` is — this
     * is the server's invariant (see STORAGE-SPEC.md), and the memory backend
     * must honour it identically (see predicate.ts / memory.ts).
     */
    async function walkByOwner(coll: Collection<Task>, order: "asc" | "desc"): Promise<string[]> {
      const seen: string[] = [];
      let after: string | undefined;
      let pages = 0;
      do {
        const p = await coll.page({
          orderBy: "owner",
          order,
          limit: 2,
          ...(after ? { after } : {}),
        });
        seen.push(...ids(p.items));
        after = p.nextCursor;
        pages++;
      } while (after && pages < 10);
      return seen;
    }

    test("full walk over a SPARSE order field visits every row exactly once, both directions", async () => {
      const coll = make();
      // Two rows with `owner`, two without — chosen so a limit-2 page boundary
      // falls EXACTLY on the null/non-null seam in both sort directions (see
      // "rows missing the order field sort LAST ascending" above for the
      // underlying order: non-null asc / id, then the null block by id).
      const rows: Task[] = [
        { id: "a", status: "todo", rank: 1, searchText: "", owner: "b1" },
        { id: "b", status: "todo", rank: 2, searchText: "", owner: "b2" },
        { id: "c", status: "todo", rank: 3, searchText: "" }, // no owner
        { id: "d", status: "todo", rank: 4, searchText: "" }, // no owner
      ];
      for (const row of rows) await coll.put(row);

      const asc = await walkByOwner(coll, "asc");
      expect(asc).toEqual(["a", "b", "c", "d"]);
      expect(new Set(asc).size).toBe(4);

      const desc = await walkByOwner(coll, "desc");
      // Null block (id-asc) first, then non-null descending by value.
      expect(desc).toEqual(["c", "d", "b", "a"]);
      expect(new Set(desc).size).toBe(4);
    });

    test("full walk when EVERY row lacks the order field still terminates, visiting each once", async () => {
      const coll = make();
      for (let i = 0; i < 5; i++) {
        await coll.put({ id: `r${i}`, status: "todo", rank: i, searchText: "" }); // no owner
      }
      for (const order of ["asc", "desc"] as const) {
        const seen = await walkByOwner(coll, order);
        // All-null: both directions fall back to the id-ascending interior
        // order, so the walk is identical either way.
        expect(seen).toEqual(["r0", "r1", "r2", "r3", "r4"]);
        expect(new Set(seen).size).toBe(5);
      }
    });

    test("count() honours operators", async () => {
      const c = await seeded(make);
      expect(await c.count()).toBe(4);
      expect(await c.count({ where: { status: "todo" } })).toBe(2);
      expect(await c.count({ where: { rank: { gte: 9 } } as never })).toBe(2);
      expect(await c.count({ where: { owner: { exists: false } } as never })).toBe(1);
    });

    test("count() agrees with a full query() walk for the same where, across operators", async () => {
      const c = await seeded(make);
      const wheres: Array<Record<string, unknown>> = [
        {},
        { status: "todo" },
        { status: { neq: "done" } },
        { status: { in: ["done", "blocked"] } },
        { rank: { gte: 5 } },
        { rank: { gt: 2, lte: 9 } },
        { owner: { exists: false } },
        { owner: null },
        { searchText: { match: "report" } },
        { searchText: { match: '"quarterly planning"' } },
      ];
      for (const where of wheres) {
        const rows = await c.query({ where: where as never });
        expect(await c.count({ where: where as never })).toBe(rows.length);
      }
    });
  });
}

// ─── 4. AbortSignal ──────────────────────────────────────────────────────────
//
// `signal` cancels the in-flight request AND (for `query()`) stops the
// keyset page walk BETWEEN pages, so an abandoned scan does not keep issuing
// requests nobody will read. Every abort — pre-flight, mid-flight, or between
// pages — normalizes to one shape: a `UnifiedError` with `code: "aborted"`,
// matching how the rest of the SDK already treats caller aborts (the retry
// loop in core/client.ts, `_internal/chunkedUpload.ts`'s multi-request loop).

/** Fails the test if `p` does not reject with the canonical abort error. */
async function expectAborted(p: Promise<unknown>): Promise<void> {
  try {
    await p;
    throw new Error("expected the promise to reject");
  } catch (err) {
    expect(err).toBeInstanceOf(UnifiedError);
    expect((err as UnifiedError).code).toBe("aborted");
  }
}

/**
 * Wraps any StorageBackend, counting invocations of the read methods and
 * (optionally) running a hook right after each `query()` resolves — used to
 * prove an abort stops the page walk BETWEEN pages, not just the final
 * rejection after every page was already fetched.
 */
class CountingBackend implements StorageBackend {
  readonly name: string;
  readonly calls: string[] = [];

  constructor(
    private readonly inner: StorageBackend,
    private readonly afterQuery?: () => void,
  ) {
    this.name = inner.name;
  }

  available(): boolean {
    return this.inner.available();
  }
  ensureCollection(...args: Parameters<StorageBackend["ensureCollection"]>) {
    return this.inner.ensureCollection(...args);
  }
  put(...args: Parameters<StorageBackend["put"]>) {
    return this.inner.put(...args);
  }
  get(...args: Parameters<StorageBackend["get"]>) {
    this.calls.push("get");
    return this.inner.get(...args);
  }
  async query(...args: Parameters<StorageBackend["query"]>) {
    this.calls.push("query");
    const page = await this.inner.query(...args);
    this.afterQuery?.();
    return page;
  }
  count(...args: Parameters<StorageBackend["count"]>) {
    this.calls.push("count");
    return this.inner.count(...args);
  }
  delete(...args: Parameters<StorageBackend["delete"]>) {
    return this.inner.delete(...args);
  }
  readBlob(...args: Parameters<StorageBackend["readBlob"]>) {
    this.calls.push("readBlob");
    return this.inner.readBlob(...args);
  }
  listVersions(...args: Parameters<StorageBackend["listVersions"]>) {
    return this.inner.listVersions(...args);
  }
  getVersion(...args: Parameters<StorageBackend["getVersion"]>) {
    return this.inner.getVersion(...args);
  }
  readVersionBlob(...args: Parameters<StorageBackend["readVersionBlob"]>) {
    return this.inner.readVersionBlob(...args);
  }
  revert(...args: Parameters<StorageBackend["revert"]>) {
    return this.inner.revert(...args);
  }
}

describe("storage query — AbortSignal wire safety", () => {
  test("no signal: query() behaves exactly as before", async () => {
    const { calls, tasks } = capturing();
    const rows = await tasks.query({ where: { status: "todo" } });
    expect(rows).toEqual([]);
    expect(calls.map((c) => c.path)).toContain("/api/v1/storage/query-v2");
  });

  test("signal is never serialized into the request body", async () => {
    const { calls, tasks } = capturing();
    const controller = new AbortController();
    await tasks.query({ where: { status: "todo" }, signal: controller.signal });
    expect(lastQuery(calls)).not.toHaveProperty("signal");
    expect(JSON.stringify(calls)).not.toContain("signal");
  });
});

for (const [label, make] of [
  ["MemoryBackend", memoryCollection],
  ["CloudStorageBackend (over the wire)", fakeServer],
] as const) {
  describe(`storage query — AbortSignal (${label})`, () => {
    test('a pre-aborted signal rejects query()/page()/count()/get() with code "aborted"', async () => {
      const c = await seeded(make);
      const controller = new AbortController();
      controller.abort();
      const signal = controller.signal;
      await expectAborted(c.query({ signal }));
      await expectAborted(c.page({ signal }));
      await expectAborted(c.count({ signal }));
      await expectAborted(c.get("t1", { signal }));
    });
  });
}

test("MemoryBackend: a pre-aborted signal issues zero backend calls", async () => {
  const backend = new CountingBackend(new MemoryBackend());
  const sdk = new UnifiedAI({ appId: "tasks", storage: backend });
  const tasks = sdk.storage.namespace().collection<Task>("tasks", SCHEMA);
  for (const row of SEED) await tasks.put(row);
  backend.calls.length = 0;
  const controller = new AbortController();
  controller.abort();
  const signal = controller.signal;
  await expectAborted(tasks.query({ signal }));
  await expectAborted(tasks.page({ signal }));
  await expectAborted(tasks.count({ signal }));
  await expectAborted(tasks.get("t1", { signal }));
  expect(backend.calls).toEqual([]);
});

test("CloudStorageBackend: a pre-aborted signal issues zero HTTP calls", async () => {
  const { calls, tasks } = capturing();
  const controller = new AbortController();
  controller.abort();
  const signal = controller.signal;
  await expectAborted(tasks.query({ signal }));
  await expectAborted(tasks.page({ signal }));
  await expectAborted(tasks.count({ signal }));
  await expectAborted(tasks.get("t1", { signal }));
  expect(calls.length).toBe(0);
});

test("MemoryBackend: aborting between pages stops the walk (does not fetch remaining pages)", async () => {
  const controller = new AbortController();
  const backend = new CountingBackend(new MemoryBackend(), () => controller.abort());
  const sdk = new UnifiedAI({ appId: "tasks", storage: backend });
  const tasks = sdk.storage.namespace().collection<Task>("tasks", SCHEMA);
  // > one max page (1000), so an unbounded query() must walk at least 2 pages
  // if it isn't stopped.
  for (let i = 0; i < 1200; i++) {
    await tasks.put({
      id: `t${String(i).padStart(4, "0")}`,
      status: "todo",
      rank: i,
      searchText: "",
    });
  }
  backend.calls.length = 0;
  await expectAborted(tasks.query({ orderBy: "rank", signal: controller.signal }));
  expect(backend.calls.filter((c) => c === "query")).toHaveLength(1);
});

test("CloudStorageBackend: aborting between pages stops the walk (does not fetch remaining pages)", async () => {
  const controller = new AbortController();
  let queryCalls = 0;
  const fakeFetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/query-v2")) {
      queryCalls++;
      const body =
        queryCalls === 1
          ? {
              records: [
                {
                  id: "t1",
                  metadata: {},
                  version: 1,
                  createdAt: 0,
                  updatedAt: 0,
                  hasBlob: false,
                },
              ],
              nextCursor: "CURSOR1",
            }
          : { records: [] };
      // Simulate the caller aborting right after the first page comes back —
      // the loop must not go on to fetch page 2.
      if (queryCalls === 1) controller.abort();
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const sdk = new UnifiedAI({
    apiUrl: "https://example.test",
    fetch: fakeFetch,
    token: "t",
    appId: "tasks",
  });
  const tasks = sdk.storage.namespace().collection<Task>("tasks", SCHEMA);
  await expectAborted(tasks.query({ signal: controller.signal }));
  expect(queryCalls).toBe(1);
});
