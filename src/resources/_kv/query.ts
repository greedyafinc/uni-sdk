// In-memory where/order/paginate helpers shared by the storage Memory backend
// and the sync engine's collection reads. INTERNAL — not exported from any
// public barrel. `KvQuery` is a structural twin of storage's public
// `BackendQuery`, so backend queries flow through without conversion while this
// module stays import-free of any one subsystem.

/** The backend-level query shape these helpers operate on (field names are plain strings). */
export interface KvQuery {
  where?: Record<string, unknown>;
  orderBy?: string;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
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
  q: KvQuery,
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
