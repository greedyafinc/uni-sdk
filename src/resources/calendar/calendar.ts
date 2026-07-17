// Public Calendar facade exposed as `sdk.calendar`. Stateless — no constructor
// args, no Core dependency; every method delegates to the free functions in
// datetime.ts / recurrence.ts / sync-adapter.ts (keep them in sync). Methods
// live on the prototype so we don't allocate fresh closures per UnifiedAI
// instance (same pattern as Helpers).

import type { SyncOp } from "../sync/types";
import {
  addDaysInZone,
  addMonthsInZone,
  dayRange,
  isSameDayInZone,
  monthGrid,
  startOfDayInZone,
  startOfMonthInZone,
  startOfWeekInZone,
  weekRange,
} from "./datetime";
import { expandOccurrences } from "./recurrence";
import {
  addExdateOp,
  createItemOp,
  deleteItemOp,
  itemToMetadata,
  newId,
  parseCalendarItem,
  setOverrideOp,
  updateItemOp,
} from "./sync-adapter";
import type {
  CalendarItem,
  DayCell,
  ExpandOptions,
  Occurrence,
  OccurrenceOverride,
  Range,
  Weekday,
} from "./types";

export class Calendar {
  monthGrid(year: number, month: number, tz: string, weekStart?: Weekday): DayCell[] {
    return monthGrid(year, month, tz, weekStart);
  }
  weekRange(epochMs: number, tz: string, weekStart?: Weekday): Range {
    return weekRange(epochMs, tz, weekStart);
  }
  dayRange(epochMs: number, tz: string): Range {
    return dayRange(epochMs, tz);
  }
  startOfDay(epochMs: number, tz: string): number {
    return startOfDayInZone(epochMs, tz);
  }
  startOfWeek(epochMs: number, tz: string, weekStart?: Weekday): number {
    return startOfWeekInZone(epochMs, tz, weekStart);
  }
  startOfMonth(epochMs: number, tz: string): number {
    return startOfMonthInZone(epochMs, tz);
  }
  addDays(epochMs: number, days: number, tz: string): number {
    return addDaysInZone(epochMs, days, tz);
  }
  addMonths(epochMs: number, months: number, tz: string): number {
    return addMonthsInZone(epochMs, months, tz);
  }
  isSameDay(a: number, b: number, tz: string): boolean {
    return isSameDayInZone(a, b, tz);
  }
  expand(
    item: CalendarItem,
    rangeStart: number,
    rangeEnd: number,
    opts?: ExpandOptions,
  ): Occurrence[] {
    return expandOccurrences(item, rangeStart, rangeEnd, opts);
  }
  newId(): string {
    return newId();
  }
  toMetadata(item: CalendarItem): Record<string, unknown> {
    return itemToMetadata(item);
  }
  parseItem(metadata: Record<string, unknown>): CalendarItem | null {
    return parseCalendarItem(metadata);
  }
  createItemOp(item: CalendarItem): SyncOp {
    return createItemOp(item);
  }
  updateItemOp(id: string, patch: Record<string, unknown>): SyncOp {
    return updateItemOp(id, patch);
  }
  deleteItemOp(id: string): SyncOp {
    return deleteItemOp(id);
  }
  setOverrideOp(item: CalendarItem, override: OccurrenceOverride): SyncOp {
    return setOverrideOp(item, override);
  }
  addExdateOp(item: CalendarItem, key: string): SyncOp {
    return addExdateOp(item, key);
  }
}
