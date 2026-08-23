// Query predicate compilation + in-memory evaluation for `sdk.storage`.
//
// ONE source of truth for what a `Query<T>.where` MEANS. `compileWhere()`
// lowers the public predicate surface to the flat `BackendWhere[]` wire shape
// that unified-api's `/query-v2` consumes; `matchesWhere()` re-implements the
// SAME semantics in JS for in-process backends. Both live here precisely so the
// cloud and memory backends cannot drift — the conformance suite runs one set
// of expectations against both.
//
// The semantics deliberately mirror POSTGRES, not JavaScript, because the cloud
// backend is the production path and a JS-flavoured memory backend would make
// tests lie:
//   - Comparisons are against `metadata->>field` (TEXT) for eq/neq/in, so the
//     server compares STRINGIFIED values. `where: { n: 5 }` matches a stored
//     `5`. We therefore compare `String(a) === String(b)`, not `===`.
//   - SQL three-valued logic: a row whose key is ABSENT never satisfies eq,
//     neq, in, a range op, or match. Only `exists: false` matches it. (JS's
//     `!==` would wrongly let absent keys pass `neq`.)
//   - "Key absent" is the only no-value state: the write RPC runs
//     `jsonb_strip_nulls`, so a stored `null` is indistinguishable from a
//     missing key. `where: { x: null }` therefore compiles to `exists: false`
//     rather than an equality that can never match. (The memory backend strips
//     nulls on `put` for the same reason — see memory.ts.)
//   - Range ops with `type: "number"` hit `metadata->field` (JSONB), where
//     comparison is numeric and cross-type ordering follows jsonb's fixed
//     rank; `type: "text"` hits `metadata->>field` and compares as text.
import { base64ToBytes, bytesToBase64Url } from "../../core/_internal/base64";
import { storageError } from "./errors";
import type { BackendWhere, OrderType, Predicate, SortOrder, WhereOp } from "./types";

/** The one metadata field `match` (full-text) may target — the only field the
 * server derives its generated tsvector column from. */
export const SEARCH_TEXT_FIELD = "searchText";

/** Server-side cap on `in` list length (queryV2.ts MAX_IN). Mirrored client-side
 * so the failure is comprehensible without a round-trip. */
export const MAX_IN = 50;

/** Server-side page ceiling (queryV2.ts MAX_LIMIT). */
export const MAX_PAGE = 1000;

/** Server-side page default when no limit is given (queryV2.ts DEFAULT_LIMIT). */
export const DEFAULT_PAGE = 100;

const OPS = new Set<string>(["eq", "neq", "in", "gt", "gte", "lt", "lte", "exists", "match"]);

const RANGE_OPS = new Set<string>(["gt", "gte", "lt", "lte"]);

type Scalar = string | number | boolean;

function isScalar(v: unknown): v is Scalar {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function assertScalar(v: unknown, field: string, op: string): Scalar {
  if (isScalar(v)) return v;
  throw storageError(
    "invalid_input",
    `where.${field}.${op} needs a string, number, or boolean (got ${describe(v)})`,
  );
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v;
}

/**
 * Is this value an OPERATOR OBJECT (`{ gte: 1 }`) rather than an equality
 * shorthand that happens to be an object?
 *
 * A plain, non-empty object ALL of whose keys are operator names. Requiring
 * *every* key to be an operator is what keeps a record field that legitimately
 * holds `{ eq: ..., unit: ... }` from being mistaken for a predicate — and it
 * turns a typo (`{ gte: 1, ltee: 5 }`) into a comprehensible "unknown operator"
 * error instead of a silent equality match against an object that can never
 * compare equal.
 */
function isOperatorObject(v: unknown, field: string): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  if (Array.isArray(v) || v instanceof Uint8Array || v instanceof ArrayBuffer) return false;
  if (v instanceof Date) return false;
  const keys = Object.keys(v);
  if (keys.length === 0) return false;
  if (keys.every((k) => OPS.has(k))) return true;
  // A PARTIAL match is almost always a typo (`{ gte: 1, ltee: 5 }`). Falling
  // through to equality would compare an object as text and fail with a
  // baffling message, so name the offending keys instead.
  const unknown = keys.filter((k) => !OPS.has(k));
  if (unknown.length < keys.length) {
    throw storageError(
      "invalid_input",
      `where.${field} has unknown operator(s): ${unknown.join(", ")} — ` +
        `valid operators are ${[...OPS].join(", ")}`,
    );
  }
  return false;
}

/** Range ops infer their cast from the RUNTIME value — a number compares
 * numerically (`metadata->f`), anything else as text (`metadata->>f`). No
 * declaration needed, and it can never disagree with the operand. */
function rangeType(value: Scalar): OrderType {
  return typeof value === "number" ? "number" : "text";
}

function compileOp(field: string, op: string, raw: unknown): BackendWhere {
  if (op === "exists") {
    if (typeof raw !== "boolean") {
      throw storageError("invalid_input", `where.${field}.exists needs a boolean`);
    }
    return { field, op: "exists", value: raw };
  }

  if (op === "in") {
    if (!Array.isArray(raw)) {
      throw storageError("invalid_input", `where.${field}.in needs an array`);
    }
    if (raw.length > MAX_IN) {
      throw storageError(
        "invalid_input",
        `where.${field}.in has ${raw.length} items (max ${MAX_IN}) — split the query`,
      );
    }
    return { field, op: "in", value: raw.map((v) => assertScalar(v, field, "in")) };
  }

  if (op === "match") {
    // Only `searchText` has a generated tsvector column server-side. Reject
    // anything else HERE so the message names the real constraint instead of
    // surfacing as an opaque 400 (or, worse, silently matching nothing on a
    // backend that guessed).
    if (field !== SEARCH_TEXT_FIELD) {
      throw storageError(
        "invalid_input",
        `where.${field}.match is not supported — full-text \`match\` only works on ` +
          `"${SEARCH_TEXT_FIELD}", the one field with a full-text index. Put the ` +
          `searchable text in a "${SEARCH_TEXT_FIELD}" field.`,
      );
    }
    if (typeof raw !== "string" || raw.length === 0) {
      throw storageError("invalid_input", `where.${field}.match needs a non-empty string`);
    }
    return { field, op: "match", value: raw };
  }

  const value = assertScalar(raw, field, op);
  if (RANGE_OPS.has(op)) {
    return { field, op: op as WhereOp, value, type: rangeType(value) };
  }
  // eq / neq — compared as text server-side regardless of cast, so no `type`.
  return { field, op: op as WhereOp, value };
}

/**
 * Lower a public `where` map to the flat, ANDed wire clauses.
 *
 * - a bare value is equality shorthand;
 * - `null`/`undefined` is "this field has no value" → `exists: false` (see the
 *   module doc — the server cannot store a null, so equality against one is
 *   unsatisfiable by construction and used to fail silently);
 * - an operator object contributes one clause per operator, ANDed, so
 *   `{ gte: 1, lte: 5 }` is a range.
 */
export function compileWhere<T>(
  where: { [K in keyof T]?: Predicate<T[K]> } | undefined,
): BackendWhere[] {
  if (!where) return [];
  const out: BackendWhere[] = [];
  for (const field of Object.keys(where)) {
    const raw = (where as Record<string, unknown>)[field];
    if (raw === undefined || raw === null) {
      out.push({ field, op: "exists", value: false });
      continue;
    }
    if (isOperatorObject(raw, field)) {
      for (const op of Object.keys(raw)) out.push(compileOp(field, op, raw[op]));
      continue;
    }
    out.push(compileOp(field, "eq", raw));
  }
  return out;
}

// ─── In-memory evaluation (must agree with Postgres, not with JS) ────────────

/** jsonb's fixed cross-type ordering: Object > Array > Boolean > Number > String > Null. */
function jsonbRank(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "string") return 1;
  if (typeof v === "number") return 2;
  if (typeof v === "boolean") return 3;
  if (Array.isArray(v)) return 4;
  return 5;
}

/**
 * Compare two stored values the way the server's chosen extraction path does.
 * `type: "number"` mirrors JSONB comparison (numeric for numbers, jsonb rank
 * across types); anything else mirrors TEXT comparison of the stringified value.
 */
export function compareValues(a: unknown, b: unknown, type: OrderType | undefined): number {
  // A missing key extracts as SQL NULL, and Postgres treats NULL as the LARGEST
  // value: `ORDER BY x` is NULLS LAST, `ORDER BY x DESC` is NULLS FIRST. Sorting
  // them first (the intuitive JS reading) would put sparse rows at the opposite
  // end of the page from the cloud backend.
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an || bn) return an && bn ? 0 : an ? 1 : -1;

  if (type === "number") {
    const ra = jsonbRank(a);
    const rb = jsonbRank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
    if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  }
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa.localeCompare(sb);
}

/** Tokenise for the in-memory `match` substitute (see matchesClause). */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * In-memory stand-in for Postgres `websearch_to_tsquery('simple', q) @@ tsv`.
 * Faithful to the parts callers actually rely on: terms are ANDed, a
 * "quoted phrase" must appear contiguously, and a -term is negated. It is a
 * WHOLE-TOKEN match (not substring), matching tsvector, and it does NOT stem —
 * the server's 'simple' config does not stem either.
 */
function websearchMatch(haystack: string, query: string): boolean {
  const hay = tokens(haystack);
  const joined = ` ${hay.join(" ")} `;
  const phrases = [...query.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
  const rest = query.replace(/"[^"]*"/g, " ");

  for (const phrase of phrases) {
    const p = tokens(phrase);
    if (p.length === 0) continue;
    if (!joined.includes(` ${p.join(" ")} `)) return false;
  }

  const terms = rest.split(/\s+/).filter(Boolean);
  let sawPositive = phrases.some((p) => tokens(p).length > 0);
  for (const term of terms) {
    if (term.toLowerCase() === "or") continue; // OR is not modelled; treat as noise
    const negated = term.startsWith("-");
    const body = tokens(negated ? term.slice(1) : term);
    if (body.length === 0) continue;
    const present = body.every((t) => hay.includes(t));
    if (negated) {
      if (present) return false;
    } else {
      sawPositive = true;
      if (!present) return false;
    }
  }
  // A query with only negations still has to match something; tsquery would
  // reject it, so treat "no positive terms" as no-op rather than match-all.
  return sawPositive || terms.length === 0;
}

function matchesClause(metadata: Record<string, unknown>, w: BackendWhere): boolean {
  const present =
    Object.hasOwn(metadata, w.field) &&
    metadata[w.field] !== undefined &&
    metadata[w.field] !== null;

  if (w.op === "exists") return present === (w.value === true);
  // SQL three-valued logic: NULL <op> x is never TRUE, so an absent key fails
  // EVERY operator except `exists: false`. This is the single most likely place
  // for a JS-flavoured backend to diverge (`undefined !== "x"` is true in JS).
  if (!present) return false;

  const actual = metadata[w.field];

  switch (w.op) {
    case "eq":
      return String(actual) === String(w.value);
    case "neq":
      return String(actual) !== String(w.value);
    case "in":
      return Array.isArray(w.value) && w.value.map((v) => String(v)).includes(String(actual));
    case "gt":
      return compareValues(actual, w.value, w.type) > 0;
    case "gte":
      return compareValues(actual, w.value, w.type) >= 0;
    case "lt":
      return compareValues(actual, w.value, w.type) < 0;
    case "lte":
      return compareValues(actual, w.value, w.type) <= 0;
    case "match":
      return typeof actual === "string" && websearchMatch(actual, String(w.value));
    default:
      return false;
  }
}

/** Every clause must hold (ANDed), with Postgres semantics. */
export function matchesWhere(
  metadata: Record<string, unknown>,
  clauses: readonly BackendWhere[] | undefined,
): boolean {
  if (!clauses || clauses.length === 0) return true;
  for (const w of clauses) if (!matchesClause(metadata, w)) return false;
  return true;
}

// ─── Keyset cursor (byte-compatible with unified-api's queryV2.ts) ───────────

/** Decoded cursor payload: the last row's order value (`o`, absent when the
 * query had no `orderBy`) and its id (`i`). */
export interface Cursor {
  v: 1;
  o?: string | number;
  i: string;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

export function encodeCursor(cursor: Cursor): string {
  return bytesToBase64Url(utf8Encoder.encode(JSON.stringify(cursor)));
}

export function decodeCursor(token: string): Cursor {
  let parsed: unknown;
  try {
    const padded = token.replace(/-/g, "+").replace(/_/g, "/");
    parsed = JSON.parse(utf8Decoder.decode(base64ToBytes(padded)));
  } catch {
    throw storageError("invalid_input", "invalid pagination cursor");
  }
  const c = parsed as Cursor | null;
  if (
    !c ||
    typeof c !== "object" ||
    c.v !== 1 ||
    typeof c.i !== "string" ||
    (c.o !== undefined && typeof c.o !== "string" && typeof c.o !== "number")
  ) {
    throw storageError("invalid_input", "invalid pagination cursor");
  }
  return c;
}

/** Build the cursor a page ends on. Mirrors the server's `cursorForRow`. */
export function cursorForRow(orderValue: unknown, id: string): string {
  const o =
    typeof orderValue === "string" || typeof orderValue === "number" ? orderValue : undefined;
  return encodeCursor(o === undefined ? { v: 1, i: id } : { v: 1, o, i: id });
}

/** Clamp a requested page size the way the server does. */
export function clampPage(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_PAGE;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_PAGE;
  return Math.min(MAX_PAGE, Math.trunc(raw));
}

export type { SortOrder };
