import type { BackendWhere, OrderType, Predicate, SortOrder } from "./types.js";
/** The one metadata field `match` (full-text) may target — the only field the
 * server derives its generated tsvector column from. */
export declare const SEARCH_TEXT_FIELD = "searchText";
/** Server-side cap on `in` list length (queryV2.ts MAX_IN). Mirrored client-side
 * so the failure is comprehensible without a round-trip. */
export declare const MAX_IN = 50;
/** Server-side page ceiling (queryV2.ts MAX_LIMIT). */
export declare const MAX_PAGE = 1000;
/** Server-side page default when no limit is given (queryV2.ts DEFAULT_LIMIT). */
export declare const DEFAULT_PAGE = 100;
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
export declare function compileWhere<T>(where: {
    [K in keyof T]?: Predicate<T[K]>;
} | undefined): BackendWhere[];
/**
 * Compare two stored values the way the server's chosen extraction path does.
 * `type: "number"` mirrors JSONB comparison (numeric for numbers, jsonb rank
 * across types); anything else mirrors TEXT comparison of the stringified value.
 */
export declare function compareValues(a: unknown, b: unknown, type: OrderType | undefined): number;
/** Every clause must hold (ANDed), with Postgres semantics. */
export declare function matchesWhere(metadata: Record<string, unknown>, clauses: readonly BackendWhere[] | undefined): boolean;
/** Decoded cursor payload: the last row's order value (`o`, absent when the
 * query had no `orderBy`) and its id (`i`). */
export interface Cursor {
    v: 1;
    o?: string | number;
    i: string;
}
export declare function encodeCursor(cursor: Cursor): string;
export declare function decodeCursor(token: string): Cursor;
/** Build the cursor a page ends on. Mirrors the server's `cursorForRow`. */
export declare function cursorForRow(orderValue: unknown, id: string): string;
/** Clamp a requested page size the way the server does. */
export declare function clampPage(raw: number | undefined): number;
export type { SortOrder };
//# sourceMappingURL=predicate.d.ts.map