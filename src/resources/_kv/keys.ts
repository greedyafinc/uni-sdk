// Composite-key helpers shared by every in-process record store in the SDK
// (the storage Memory backend, the sync engine's materialized view, and the
// FakeSyncServer test double). INTERNAL — not exported from any public barrel.
//
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
