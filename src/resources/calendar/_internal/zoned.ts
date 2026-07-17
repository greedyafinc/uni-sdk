// Low-level Intl-based timezone primitives (private to the calendar module).
// A per-tz formatter cache keeps repeated conversions cheap — creating an
// Intl.DateTimeFormat is ~100x the cost of formatting with one.

import type { Weekday, ZonedFields } from "../types";

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** The wall-clock fields of `epochMs` observed in `tz`. */
export function utcToZonedFields(epochMs: number, tz: string): ZonedFields {
  const parts = formatterFor(tz).formatToParts(new Date(epochMs));
  const num = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  let hour = num("hour");
  // Some engines emit "24:00" for midnight under h23 — normalize to 0.
  if (hour === 24) hour = 0;
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour,
    minute: num("minute"),
    second: num("second"),
  };
}

/** Offset such that `localWallAsUTC = epochMs + offset` (e.g. NY winter → -5h in ms). */
export function getTimeZoneOffsetMs(epochMs: number, tz: string): number {
  const f = utcToZonedFields(epochMs, tz);
  const asUTC = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUTC - epochMs;
}

/**
 * Wall-clock fields in `tz` → UTC instant. Two-pass to resolve DST:
 * - Spring-forward (non-existent wall time): lands on the post-transition instant.
 * - Fall-back (ambiguous wall time): converges to the FIRST/earlier occurrence.
 * Both policies are deterministic.
 */
export function zonedFieldsToUtc(f: ZonedFields, tz: string): number {
  const ts0 = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second, f.ms ?? 0);
  const off0 = getTimeZoneOffsetMs(ts0, tz);
  const utc1 = ts0 - off0;
  const off1 = getTimeZoneOffsetMs(utc1, tz);
  return off1 === off0 ? utc1 : ts0 - off1;
}

const WEEKDAYS: readonly Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** Weekday of a pure calendar date (proleptic Gregorian, tz-independent). */
export function weekdayOf(year: number, month: number, day: number): Weekday {
  const idx = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  // getUTCDay() is always 0..6 so the index is in range; `?? "SU"` satisfies
  // noUncheckedIndexedAccess without a non-null assertion.
  return WEEKDAYS[idx] ?? "SU";
}

/** Index of a Weekday literal, 0=SU..6=SA. */
export function weekdayIndex(w: Weekday): number {
  return WEEKDAYS.indexOf(w);
}

/** Days in `year`-`month` (month 1..12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
