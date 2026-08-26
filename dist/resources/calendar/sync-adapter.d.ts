import type { SyncOp } from "../sync/types.js";
import type { CalendarItem, CalendarMeta, OccurrenceOverride } from "./types.js";
export declare const CALENDAR_NS: "calendar";
export declare const ITEMS_COLLECTION: "items";
export declare const CALENDARS_COLLECTION: "calendars";
/** Browser-safe UUID v4 — crypto.randomUUID when available, Math.random fallback. */
export declare function newId(): string;
/** Plain-JSON metadata bag for a calendar item (undefined keys dropped). */
export declare function itemToMetadata(item: CalendarItem): Record<string, unknown>;
/** Plain-JSON metadata bag for a calendar container (undefined keys dropped). */
export declare function calendarToMetadata(cal: CalendarMeta): Record<string, unknown>;
/**
 * Parse a metadata bag back into a CalendarItem. Tolerant: unknown keys are
 * ignored, malformed optional fields are dropped, malformed recurrence yields a
 * valid single item. Returns null only when required fields are missing/wrong.
 */
export declare function parseCalendarItem(metadata: Record<string, unknown>): CalendarItem | null;
/** Parse a metadata bag back into a CalendarMeta; null when required fields are missing. */
export declare function parseCalendar(metadata: Record<string, unknown>): CalendarMeta | null;
export declare function createItemOp(item: CalendarItem): SyncOp;
/** Shallow-merge patch; nested arrays (overrides, exdates, …) must be passed whole. */
export declare function updateItemOp(id: string, patch: Record<string, unknown>): SyncOp;
export declare function deleteItemOp(id: string): SyncOp;
/** Merge `override` into the item's overrides by originalStart (replace or append). */
export declare function setOverrideOp(item: CalendarItem, override: OccurrenceOverride): SyncOp;
/** Union `key` into the item's exdates (no duplicates). */
export declare function addExdateOp(item: CalendarItem, key: string): SyncOp;
export declare function createCalendarOp(cal: CalendarMeta): SyncOp;
export declare function updateCalendarOp(id: string, patch: Record<string, unknown>): SyncOp;
export declare function deleteCalendarOp(id: string): SyncOp;
//# sourceMappingURL=sync-adapter.d.ts.map