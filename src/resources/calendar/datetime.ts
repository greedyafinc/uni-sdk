// Public tz-aware date-math helpers for the calendar module. All pure free
// functions — no transport, no client dependency, no `node:*` imports.
// Formatting is left to the app; these return instants, field bags, and
// YYYY-MM-DD date strings.

import { UnifiedError } from "../../core/errors";
import {
  daysInMonth,
  getTimeZoneOffsetMs,
  utcToZonedFields,
  weekdayIndex,
  weekdayOf,
  zonedFieldsToUtc,
} from "./_internal/zoned";
import type { DayCell, Range, Weekday } from "./types";

export { getTimeZoneOffsetMs, utcToZonedFields, zonedFieldsToUtc };

function inputError(message: string): UnifiedError {
  return new UnifiedError("invalid_input", message);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** The local YYYY-MM-DD date of `epochMs` observed in `tz`. */
export function dateStringInZone(epochMs: number, tz: string): string {
  const f = utcToZonedFields(epochMs, tz);
  return `${f.year}-${pad(f.month)}-${pad(f.day)}`;
}

/** Split a YYYY-MM-DD string into numeric fields; throws on malformed input. */
export function parseDateString(s: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw inputError(`invalid date string "${s}"; expected YYYY-MM-DD`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw inputError(`invalid date string "${s}"; month/day out of range`);
  }
  return { year, month, day };
}

/** The instant at which `epochMs`'s local day begins in `tz` (00:00:00 local). */
export function startOfDayInZone(epochMs: number, tz: string): number {
  const f = utcToZonedFields(epochMs, tz);
  return zonedFieldsToUtc(
    { year: f.year, month: f.month, day: f.day, hour: 0, minute: 0, second: 0 },
    tz,
  );
}

/** The instant at which local date `dateStr` begins in `tz`. */
export function startOfDayForDate(dateStr: string, tz: string): number {
  const d = parseDateString(dateStr);
  return zonedFieldsToUtc(
    { year: d.year, month: d.month, day: d.day, hour: 0, minute: 0, second: 0 },
    tz,
  );
}

/** The exclusive end of local date `dateStr` in `tz` — the next day's start. */
export function endOfDayExclusive(dateStr: string, tz: string): number {
  return startOfDayForDate(addDaysToDateString(dateStr, 1), tz);
}

/** Start of the week containing `epochMs` in `tz`, weeks starting on `weekStart`. */
export function startOfWeekInZone(epochMs: number, tz: string, weekStart: Weekday = "MO"): number {
  const f = utcToZonedFields(epochMs, tz);
  const back = (weekdayIndex(weekdayOf(f.year, f.month, f.day)) - weekdayIndex(weekStart) + 7) % 7;
  return zonedFieldsToUtc(
    { year: f.year, month: f.month, day: f.day - back, hour: 0, minute: 0, second: 0 },
    tz,
  );
}

/** Start of the month containing `epochMs` in `tz` (the 1st, 00:00 local). */
export function startOfMonthInZone(epochMs: number, tz: string): number {
  const f = utcToZonedFields(epochMs, tz);
  return zonedFieldsToUtc(
    { year: f.year, month: f.month, day: 1, hour: 0, minute: 0, second: 0 },
    tz,
  );
}

/**
 * Add `days` calendar days keeping the local wall-clock time in `tz`. DST-safe:
 * crossing a transition preserves the local time (the elapsed real time may be
 * 23h or 25h).
 */
export function addDaysInZone(epochMs: number, days: number, tz: string): number {
  const f = utcToZonedFields(epochMs, tz);
  return zonedFieldsToUtc({ ...f, day: f.day + days }, tz);
}

/**
 * Add `months` keeping the local wall-clock time in `tz`. The day-of-month is
 * CLAMPED to the target month's length (Jan 31 +1mo → Feb 28/29). This is a UI
 * navigation helper — recurrence expansion deliberately SKIPS instead (see
 * recurrence.ts).
 */
export function addMonthsInZone(epochMs: number, months: number, tz: string): number {
  const f = utcToZonedFields(epochMs, tz);
  // Normalize the target month via Date.UTC (month may leave 1..12).
  const probe = new Date(Date.UTC(f.year, f.month - 1 + months, 1));
  const year = probe.getUTCFullYear();
  const month = probe.getUTCMonth() + 1;
  const day = Math.min(f.day, daysInMonth(year, month));
  return zonedFieldsToUtc({ ...f, year, month, day }, tz);
}

/** Pure calendar arithmetic on a YYYY-MM-DD string (tz-independent). */
export function addDaysToDateString(s: string, days: number): string {
  const d = parseDateString(s);
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Whether `a` and `b` fall on the same local calendar date in `tz`. */
export function isSameDayInZone(a: number, b: number, tz: string): boolean {
  return dateStringInZone(a, tz) === dateStringInZone(b, tz);
}

/** The [start, end) instant range of `epochMs`'s local day in `tz`. */
export function dayRange(epochMs: number, tz: string): Range {
  const start = startOfDayInZone(epochMs, tz);
  return { start, end: addDaysInZone(start, 1, tz) };
}

/** The [start, end) instant range of `epochMs`'s local week in `tz`. */
export function weekRange(epochMs: number, tz: string, weekStart: Weekday = "MO"): Range {
  const start = startOfWeekInZone(epochMs, tz, weekStart);
  return { start, end: addDaysInZone(start, 7, tz) };
}

/**
 * A month-view grid for `year`-`month` in `tz`: ALWAYS 42 cells (6×7), leading
 * and trailing cells filled from adjacent months (`inCurrentMonth: false`).
 */
export function monthGrid(
  year: number,
  month: number,
  tz: string,
  weekStart: Weekday = "MO",
): DayCell[] {
  const firstOfMonth = `${year}-${pad(month)}-01`;
  const leading = (weekdayIndex(weekdayOf(year, month, 1)) - weekdayIndex(weekStart) + 7) % 7;
  const gridStartDate = addDaysToDateString(firstOfMonth, -leading);
  const cells: DayCell[] = [];
  let date = gridStartDate;
  for (let i = 0; i < 42; i++) {
    const d = parseDateString(date);
    const nextDate = addDaysToDateString(date, 1);
    cells.push({
      date,
      start: startOfDayForDate(date, tz),
      end: startOfDayForDate(nextDate, tz),
      dayOfMonth: d.day,
      weekday: weekdayOf(d.year, d.month, d.day),
      inCurrentMonth: d.year === year && d.month === month,
    });
    date = nextDate;
  }
  return cells;
}
