// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL crash/interleave tests for the CLIENT sync engine (WorkspaceSync).
//
// These try to BREAK the engine at its hardest seams — crashing mid-bootstrap,
// hydrating a poisoned snapshot, writing while a bootstrap is mid-flight, and
// rolling back a failed optimistic apply while an unrelated delta lands
// concurrently. They drive the real engine through the FakeSyncServer transport
// seam, wrapped in a gate that lets a test PAUSE a specific bootstrap page or the
// apply POST to force a precise interleaving.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, expect, test } from "bun:test";
import { UnifiedAI } from "../../src/core/client";
import {
  FakeSyncServer,
  type SnapshotBackend,
  type SyncRecord,
  decodeSnapshot,
  encodeSnapshot,
} from "../../src/resources/sync";

const NS = "app";
const COL = "notes";

// ─── In-memory SnapshotBackend with counters ─────────────────────────────────
class MemSnapshotBackend implements SnapshotBackend {
  readonly store = new Map<string, Uint8Array>();
  clears = 0;
  saves = 0;
  load(workspaceId: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.store.get(workspaceId) ?? null);
  }
  save(workspaceId: string, bytes: Uint8Array): Promise<void> {
    this.saves += 1;
    this.store.set(workspaceId, bytes);
    return Promise.resolve();
  }
  clear(workspaceId: string): Promise<void> {
    this.clears += 1;
    this.store.delete(workspaceId);
    return Promise.resolve();
  }
}

// ─── A gate over FakeSyncServer.fetch: pause a chosen bootstrap page or apply ──
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class GatedServer {
  readonly inner = new FakeSyncServer();
  private bootstrapCount = 0;
  private bootstrapGate: { at: number; d: Deferred } | null = null;
  private applyGate: Deferred | null = null;

  get baseUrl(): string {
    return this.inner.baseUrl;
  }

  /** Block the Nth bootstrap GET until releaseBootstrap()/never (a crash). */
  pauseBootstrapAt(n: number): void {
    this.bootstrapGate = { at: n, d: deferred() };
  }
  releaseBootstrap(): void {
    this.bootstrapGate?.d.resolve();
  }
  disableBootstrapGate(): void {
    this.bootstrapGate = null;
  }
  /** Block the next apply POST until releaseApply(). */
  pauseApply(): void {
    this.applyGate = deferred();
  }
  releaseApply(): void {
    this.applyGate?.resolve();
    this.applyGate = null;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const isBootstrap = url.includes("/bootstrap") && method === "GET";
    const isApply = url.includes("/apply") && method === "POST";
    if (isBootstrap && this.bootstrapGate) {
      this.bootstrapCount += 1;
      if (this.bootstrapCount === this.bootstrapGate.at) await this.bootstrapGate.d.promise;
    }
    if (isApply && this.applyGate) await this.applyGate.promise;
    return this.inner.fetch(input, init);
  };
}

function makeSdk(server: GatedServer, backend?: SnapshotBackend): UnifiedAI {
  return new UnifiedAI({
    apiUrl: server.baseUrl,
    token: "t",
    fetch: server.fetch as unknown as typeof fetch,
    ...(backend ? { sync: backend } : {}),
  });
}

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

function record(id: string, metadata: Record<string, unknown>, syncId: number): SyncRecord {
  return {
    ns: NS,
    collection: COL,
    id,
    metadata,
    version: 1,
    deleted: false,
    syncId,
    createdAt: 0,
    updatedAt: 0,
    hasBlob: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Crash mid-bootstrap: interrupt after 2 of 5 pages, then a FRESH engine over
//    the same backend must reach the complete, correct state — and the partial
//    snapshot must NOT have been presented as a complete (delta-resumable) state.
// ─────────────────────────────────────────────────────────────────────────────
describe("adversarial: crash mid-bootstrap", () => {
  test("a partial bootstrap is never presented as complete; a fresh engine fully recovers", async () => {
    const server = new GatedServer();
    const backend = new MemSnapshotBackend();
    const COUNT = 2001; // 5 pages @ PAGE_LIMIT=500
    server.inner.seed(
      "ws",
      Array.from({ length: COUNT }, (_, i) => ({
        ns: NS,
        collection: COL,
        id: `n${i}`,
        metadata: { i },
      })),
    );

    // Crash: pause the 3rd bootstrap page forever (2 pages = 1000 rows landed).
    server.pauseBootstrapAt(3);
    const ws1 = makeSdk(server, backend).sync.workspace("ws");
    void ws1.start();
    await until(() => ws1.collection(NS, COL).list().length >= 1000);
    expect(ws1.collection(NS, COL).list().length).toBe(1000);
    await ws1.stop(); // aborts + flushes whatever partial state exists

    // The persisted snapshot must be a PARTIAL, non-resumable one: cursor === null
    // (forces a full re-bootstrap) and fewer than all rows. If the engine had
    // stamped a delta cursor here, a fresh engine would skip bootstrap and serve
    // a permanently half state as if it were live — the exact failure we guard.
    const snap = decodeSnapshot(backend.store.get("ws")!, "ws")!;
    expect(snap).not.toBeNull();
    expect(snap.cursor).toBeNull();
    expect(snap.records.length).toBe(1000);
    expect(snap.records.length).toBeLessThan(COUNT);

    // Fresh engine over the same backend → must converge to the FULL correct set.
    server.disableBootstrapGate();
    const ws2 = makeSdk(server, backend).sync.workspace("ws");
    await ws2.start();
    await ws2.sync();
    const rows = ws2.collection(NS, COL).list();
    expect(rows.length).toBe(COUNT);
    expect(ws2.collection(NS, COL).get("n0")?.metadata.i).toBe(0);
    expect(ws2.collection(NS, COL).get("n1000")?.metadata.i).toBe(1000);
    expect(ws2.collection(NS, COL).get("n2000")?.metadata.i).toBe(2000);
    await ws2.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Snapshot poisoning.
// ─────────────────────────────────────────────────────────────────────────────
describe("adversarial: snapshot poisoning", () => {
  // The FakeSyncServer cursor is btoa(JSON.stringify({e,a})); a test fabricating a
  // corrupt/rolled-back snapshot mimics that shape on purpose.
  const fakeCursor = (epoch: number, after: number) => btoa(JSON.stringify({ e: epoch, a: after }));

  test("a future cursor (same epoch) does not wedge the engine; writes still land", async () => {
    const server = new GatedServer();
    const backend = new MemSnapshotBackend();
    server.inner.seed("ws", [{ ns: NS, collection: COL, id: "a", metadata: { v: 1 } }]); // syncId 1, epoch 1

    // Snapshot whose cursor is absurdly AHEAD of the server counter.
    backend.store.set(
      "ws",
      encodeSnapshot("ws", fakeCursor(1, 999_999), [record("a", { v: 1 }, 1)], 0),
    );

    const ws = makeSdk(server, backend).sync.workspace("ws");
    await ws.start(); // hydrates; cursor present → delta path (skips bootstrap)
    await ws.sync(); // delta after=999999 → empty page, MUST NOT throw or wedge
    expect(ws.collection(NS, COL).get("a")?.metadata.v).toBe(1);
    expect(ws.status.get().state).not.toBe("error");

    // The engine is still fully usable: a real write applies and persists (it is
    // not stuck). Opaque cursors mean the server can't re-deliver a write beneath
    // the fabricated cursor, but the engine itself never wedges.
    await ws.apply([{ ns: NS, collection: COL, id: "b", patch: { v: 2 } }]);
    expect(ws.collection(NS, COL).get("b")?.metadata.v).toBe(2);
    await ws.sync();
    expect(ws.collection(NS, COL).get("b")?.metadata.v).toBe(2);
    expect(ws.status.get().state).not.toBe("error");
    await ws.stop();
  });

  test("a cursor from a different epoch → 409 → clean re-bootstrap purges poisoned rows", async () => {
    const server = new GatedServer();
    const backend = new MemSnapshotBackend();
    server.inner.seed("ws", [
      { ns: NS, collection: COL, id: "a", metadata: { v: 1 } },
      { ns: NS, collection: COL, id: "b", metadata: { v: 2 } },
    ]);

    // Poisoned snapshot: an old epoch cursor + a GHOST row that no longer exists.
    backend.store.set(
      "ws",
      encodeSnapshot("ws", fakeCursor(1, 0), [record("ghost", { evil: true }, 1)], 0),
    );
    server.inner.bumpEpoch("ws"); // server now at epoch 2

    const ws = makeSdk(server, backend).sync.workspace("ws");
    await ws.start();
    expect(
      ws.collection(NS, COL).get("ghost"),
      "stale snapshot served while revalidating",
    ).not.toBeNull();

    await ws.sync(); // delta → 409 cursor_epoch_mismatch → full reset + re-bootstrap
    expect(backend.clears).toBe(1);
    expect(ws.collection(NS, COL).get("ghost"), "ghost purged on reset").toBeNull();
    expect(ws.collection(NS, COL).get("a")?.metadata.v).toBe(1);
    expect(ws.collection(NS, COL).get("b")?.metadata.v).toBe(2);
    expect(ws.status.get().state).not.toBe("error");
    await ws.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Apply during bootstrap: an optimistic write mid-bootstrap must not be lost,
//    and must not be applied twice once the bootstrap page that echoes it lands.
// ─────────────────────────────────────────────────────────────────────────────
describe("adversarial: apply during bootstrap", () => {
  test("no lost update and no duplicate application", async () => {
    const server = new GatedServer();
    const COUNT = 501; // 2 pages
    server.inner.seed(
      "ws",
      Array.from({ length: COUNT }, (_, i) => ({
        ns: NS,
        collection: COL,
        id: `n${i}`,
        metadata: { i },
      })),
    );

    server.pauseBootstrapAt(2); // pause 2nd page → engine is mid-bootstrap
    const ws = makeSdk(server).sync.workspace("ws");
    void ws.start();
    await until(() => ws.collection(NS, COL).list().length >= 500);

    // Write a NEW id while bootstrap is parked. The apply POST is NOT gated, so it
    // reaches the server (highest syncId) and will appear in the pending page 2.
    const applyP = ws.apply([{ ns: NS, collection: COL, id: "fresh", patch: { hello: "world" } }]);
    expect(ws.collection(NS, COL).get("fresh")?.metadata.hello).toBe("world"); // optimistic
    await applyP;

    server.releaseBootstrap(); // page 2 (contains n500 + the echoed "fresh") lands
    await ws.sync();

    const fresh = ws.collection(NS, COL).get("fresh");
    expect(fresh?.metadata.hello).toBe("world"); // not lost
    expect(fresh?.version).toBe(1); // applied exactly once (dedupe held) — no double-apply
    expect(
      ws
        .collection(NS, COL)
        .list()
        .filter((r) => r.id === "fresh").length,
    ).toBe(1);
    expect(ws.collection(NS, COL).list().length).toBe(COUNT + 1); // full set + the new row
    expect(ws.collection(NS, COL).get("n0")?.metadata.i).toBe(0);
    expect(ws.collection(NS, COL).get("n500")?.metadata.i).toBe(500);
    await ws.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Rollback under interleave: a failed optimistic apply rolls back its OWN
//    touched records only — it must not clobber an unrelated change delivered by
//    a concurrent delta poll.
// ─────────────────────────────────────────────────────────────────────────────
describe("adversarial: rollback under interleave", () => {
  test("a rejected apply's rollback does not clobber a concurrently-delivered delta", async () => {
    const server = new GatedServer();
    server.inner.seed("ws", [{ ns: NS, collection: COL, id: "a", metadata: { v: 1 } }]);
    const ws = makeSdk(server).sync.workspace("ws");
    await ws.sync(); // "a"@v1 in store, cursor at head

    // An unrelated change waiting on the server, past the client's cursor.
    server.inner.applyOps("ws", [{ ns: NS, collection: COL, id: "b", replace: { v: 5 } }]);

    // Start a doomed optimistic apply on "a": failing + gated so it stays in-flight.
    server.inner.setApplyFailing(true);
    server.pauseApply();
    const applyP = ws.apply([{ ns: NS, collection: COL, id: "a", patch: { v: 2 } }]).then(
      () => "ok" as const,
      (e) => e,
    );
    expect(ws.collection(NS, COL).get("a")?.metadata.v).toBe(2); // optimistic mutation visible

    // Interleave: deliver the unrelated delta ("b") while the apply is parked.
    await ws.sync();
    expect(ws.collection(NS, COL).get("b")?.metadata.v).toBe(5);

    // Let the apply fail → rollback restores "a", MUST leave "b" untouched.
    server.releaseApply();
    const outcome = await applyP;
    expect(outcome).not.toBe("ok"); // rejected

    expect(ws.collection(NS, COL).get("a")?.metadata.v).toBe(1); // rolled back to pre-image
    expect(ws.collection(NS, COL).get("b")?.metadata.v).toBe(5); // delta survived the rollback
    await ws.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Regression: the `replace` op must be serialized to the REAL server wire
//    (boolean flag + data in `patch`), not as the object itself. Before the fix,
//    `toWireOp` emitted `replace: {object}` and the RPC threw
//    `invalid input syntax for type boolean`. The FakeSyncServer now faithfully
//    rejects a non-boolean `replace`, so this fails if the fix regresses.
// ─────────────────────────────────────────────────────────────────────────────
describe("regression: replace op wire contract", () => {
  test("ws.apply({replace}) performs a wholesale replacement, on the wire and after re-sync", async () => {
    const server = new GatedServer();
    server.inner.seed("ws", [{ ns: NS, collection: COL, id: "a", metadata: { keep: 1, drop: 2 } }]);
    const ws = makeSdk(server).sync.workspace("ws");
    await ws.sync();

    await ws.apply([{ ns: NS, collection: COL, id: "a", replace: { only: 9 } }]);
    expect(ws.collection(NS, COL).get("a")?.metadata).toEqual({ only: 9 }); // optimistic wholesale replace

    // A fresh engine reading the SAME server proves the wire was accepted and the
    // server stored a wholesale replacement (keep/drop gone).
    const ws2 = makeSdk(server).sync.workspace("ws");
    await ws2.sync();
    expect(ws2.collection(NS, COL).get("a")?.metadata).toEqual({ only: 9 });
    await ws.stop();
    await ws2.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Reconcile-on-bootstrap-complete: a row deleted server-side during an
//    offline window must not linger locally after a full re-bootstrap (which
//    carries no tombstone for it).
// ─────────────────────────────────────────────────────────────────────────────
describe("adversarial: stale-row reconcile on full bootstrap", () => {
  test("crash-partial path: a row deleted while offline is purged once bootstrap completes", async () => {
    const server = new GatedServer();
    const backend = new MemSnapshotBackend();
    // A crash-partial snapshot (cursor null → forces a full re-bootstrap) that
    // still remembers X and Y from before the outage.
    backend.store.set(
      "ws",
      encodeSnapshot("ws", null, [record("X", { v: 1 }, 1), record("Y", { v: 2 }, 2)], 0),
    );
    // The server now has only Y — X was deleted while we were away.
    server.inner.seed("ws", [{ ns: NS, collection: COL, id: "Y", metadata: { v: 2 } }]);

    const ws = makeSdk(server, backend).sync.workspace("ws");
    let fires = 0;
    await ws.start(); // hydrate X + Y (both visible, stale-while-revalidate)
    ws.collection(NS, COL).subscribe(() => {
      fires += 1;
    });
    expect(ws.collection(NS, COL).get("X")).not.toBeNull();

    await ws.sync(); // full bootstrap → complete → reconcile drops X
    expect(
      ws.collection(NS, COL).get("X"),
      "X was deleted server-side → must be purged",
    ).toBeNull();
    expect(ws.collection(NS, COL).get("Y")?.metadata.v).toBe(2); // Y survives (still live)
    expect(fires, "subscribers notified about the reconcile removal").toBeGreaterThanOrEqual(1);
    await ws.stop();
  });

  test("epoch-bumped non-crash snapshot: full re-bootstrap after 409 drops the stale row", async () => {
    const server = new GatedServer();
    const backend = new MemSnapshotBackend();
    // A NON-crash snapshot: it carries a delta cursor (epoch 1) and a stale row X.
    const staleCursor = btoa(JSON.stringify({ e: 1, a: 0 }));
    backend.store.set("ws", encodeSnapshot("ws", staleCursor, [record("X", { v: 1 }, 1)], 0));
    // Server moved to epoch 2 and never had X; it now holds Z.
    server.inner.seed("ws", [{ ns: NS, collection: COL, id: "Z", metadata: { v: 9 } }]);
    server.inner.bumpEpoch("ws");

    const ws = makeSdk(server, backend).sync.workspace("ws");
    await ws.start(); // hydrate X (bootstrapped via the cursor)
    expect(ws.collection(NS, COL).get("X")).not.toBeNull();

    await ws.sync(); // delta → 409 → full reset + re-bootstrap
    expect(
      ws.collection(NS, COL).get("X"),
      "stale X gone after epoch-reset re-bootstrap",
    ).toBeNull();
    expect(ws.collection(NS, COL).get("Z")?.metadata.v).toBe(9);
    await ws.stop();
  });
});
