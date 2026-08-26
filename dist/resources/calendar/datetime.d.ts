import { getTimeZoneOffsetMs, utcToZonedFields, zonedFieldsToUtc } from "./_internal/zoned.js";
import type { DayCell, Range, Weekday } from "./types.js";
export { getTimeZoneOffsetMs, utcToZonedFields, zonedFieldsToUtc };
/** The local YYYY-MM-DD date of `epochMs` observed in `tz`. */
export declare function dateStringInZone(epochMs: number, tz: string): string;
/** Split a YYYY-MM-DD string into numeric fields; throws on malformed input. */
export declare function parseDateString(s: string): {
    year: number;
    month: number;
    day: number;
};
/** The instant at which `epochMs`'s local day begins in `tz` (00:00:00 local). */
export declare function startOfDayInZone(epochMs: number, tz: string): number;
/** The instant at which local date `dateStr` begins in `tz`. */
export declare function startOfDayForDate(dateStr: string, tz: string): number;
/** The exclusive end of local date `dateStr` in `tz` — the next day's start. */
export declare function endOfDayExclusive(dateStr: string, tz: string): number;
/** Start of the week containing `epochMs` in `tz`, weeks starting on `weekStart`. */
export declare function startOfWeekInZone(epochMs: number, tz: string, weekStart?: Weekday): number;
/** Start of the month containing `epochMs` in `tz` (the 1st, 00:00 local). */
export declare function startOfMonthInZone(epochMs: number, tz: string): number;
/**
 * Add `days` calendar days keeping the local wall-clock time in `tz`. DST-safe:
 * crossing a transition preserves the local time (the elapsed real time may be
 * 23h or 25h).
 */
export declare function addDaysInZone(epochMs: number, days: number, tz: string): number;
/**
 * Add `months` keeping the local wall-clock time in `tz`. The day-of-month is
 * CLAMPED to the target month's length (Jan 31 +1mo → Feb 28/29). This is a UI
 * navigation helper — recurrence expansion deliberately SKIPS instead (see
 * recurrence.ts).
 */
export declare function addMonthsInZone(epochMs: number, months: number, tz: string): number;
/** Pure calendar arithmetic on a YYYY-MM-DD string (tz-independent). */
export declare function addDaysToDateString(s: string, days: number): string;
/** Whether `a` and `b` fall on the same local calendar date in `tz`. */
export declare function isSameDayInZone(a: number, b: number, tz: string): boolean;
/** The [start, end) instant range of `epochMs`'s local day in `tz`. */
export declare function dayRange(epochMs: number, tz: string): Range;
/** The [start, end) instant range of `epochMs`'s local week in `tz`. */
export declare function weekRange(epochMs: number, tz: string, weekStart?: Weekday): Range;
/**
 * A month-view grid for `year`-`month` in `tz`: ALWAYS 42 cells (6×7), leading
 * and trailing cells filled from adjacent months (`inCurrentMonth: false`).
 */
export declare function monthGrid(year: number, month: number, tz: string, weekStart?: Weekday): DayCell[];
//# sourceMappingURL=datetime.d.ts.map