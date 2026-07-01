// Shared helpers for the in-process Memory backend (used in tests / non-server
// runtimes). A host-injected backend implements the same contract itself and
// does not use these.
import type { BackendQuery } from "./types";

// Composite keys are JSON-encoded tuples — unambiguous regardless of what
// characters appear in a namespace, collection, or id (a separator char could
// collide, e.g. "a|b","c" vs "a","b|c"). JSON.stringify of a fixed-arity array
// is collision-free across tuples.

/** Identity key for one record: ["ns","collection","id"]. */
export function pkOf(ns: string, collection: string, id: string): string {
  return JSON.stringify([ns, collection, id]);
}

/** Bucket key grouping a collection's records: ["ns","collection"]. */
export function cpkOf(ns: string, collection: string): string {
  return JSON.stringify([ns, collection]);
}

/** Identity key for one version snapshot: ["ns","collection","id",version]. */
export function vpkOf(ns: string, collection: string, id: string, version: number): string {
  return JSON.stringify([ns, collection, id, version]);
}

/** Copy bytes into a standalone ArrayBuffer (so IDB stores a clean, detached buffer). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

/** Equality match: every `where` field must strict-equal the record's metadata field. */
export function matchesWhere(
  metadata: Record<string, unknown>,
  where: Record<string, unknown> | undefined,
): boolean {
  if (!where) return true;
  for (const k of Object.keys(where)) {
    if (metadata[k] !== where[k]) return false;
  }
  return true;
}

/** Comparator for `orderBy`: numeric when both are numbers, else lexicographic; nullish sorts first. */
export function compareBy(
  field: string,
  order: "asc" | "desc" | undefined,
): (a: Record<string, unknown>, b: Record<string, unknown>) => number {
  const dir = order === "desc" ? -1 : 1;
  return (a, b) => {
    const av = a[field];
    const bv = b[field];
    if (av === bv) return 0;
    if (av === undefined || av === null) return -1 * dir;
    if (bv === undefined || bv === null) return 1 * dir;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  };
}

/** Apply where → orderBy → offset → limit to an in-memory record list. */
export function applyQuery<R extends { metadata: Record<string, unknown> }>(
  rows: R[],
  q: BackendQuery,
): R[] {
  let out = q.where ? rows.filter((r) => matchesWhere(r.metadata, q.where)) : rows.slice();
  if (q.orderBy) {
    const cmp = compareBy(q.orderBy, q.order);
    out.sort((a, b) => cmp(a.metadata, b.metadata));
  }
  if (q.offset && q.offset > 0) out = out.slice(q.offset);
  if (q.limit !== undefined && q.limit >= 0) out = out.slice(0, q.limit);
  return out;
}
