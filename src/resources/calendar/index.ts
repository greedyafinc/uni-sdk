// Barrel for the calendar resource — pure temporal-items logic (tz-aware date
// math, recurrence expansion, sync-adapter serialization). Re-exported from the
// SDK's browser + node entries. All browser-safe (Intl only, no `node:*`).
// `_internal/*` is private and deliberately not re-exported.
export { Calendar } from "./calendar";
export * from "./datetime";
export * from "./recurrence";
export * from "./sync-adapter";
export type {
  AllDayItem,
  CalendarItem,
  CalendarItemFields,
  CalendarItemKind,
  CalendarMeta,
  DayCell,
  ExpandOptions,
  Frequency,
  ItemLink,
  NthWeekday,
  Occurrence,
  OccurrenceOverride,
  Range,
  RecurrenceRule,
  TimedItem,
  Weekday,
  ZonedFields,
} from "./types";
