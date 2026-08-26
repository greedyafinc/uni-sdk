import type { Weekday, ZonedFields } from "../types.js";
/** The wall-clock fields of `epochMs` observed in `tz`. */
export declare function utcToZonedFields(epochMs: number, tz: string): ZonedFields;
/** Offset such that `localWallAsUTC = epochMs + offset` (e.g. NY winter → -5h in ms). */
export declare function getTimeZoneOffsetMs(epochMs: number, tz: string): number;
/**
 * Wall-clock fields in `tz` → UTC instant. Two-pass to resolve DST:
 * - Spring-forward (non-existent wall time): lands on the post-transition instant.
 * - Fall-back (ambiguous wall time): converges to the FIRST/earlier occurrence.
 * Both policies are deterministic.
 */
export declare function zonedFieldsToUtc(f: ZonedFields, tz: string): number;
/** Weekday of a pure calendar date (proleptic Gregorian, tz-independent). */
export declare function weekdayOf(year: number, month: number, day: number): Weekday;
/** Index of a Weekday literal, 0=SU..6=SA. */
export declare function weekdayIndex(w: Weekday): number;
/** Days in `year`-`month` (month 1..12). */
export declare function daysInMonth(year: number, month: number): number;
//# sourceMappingURL=zoned.d.ts.map