// Barrel for the calendar resource — pure temporal-items logic (tz-aware date
// math, recurrence expansion, sync-adapter serialization). Re-exported from the
// SDK's browser + node entries. All browser-safe (Intl only, no `node:*`).
// `_internal/*` is private and deliberately not re-exported.
//
// Exports are curated by hand (no `export *`): the public surface is the
// `Calendar` facade, the standalone tz/date-math utilities it wraps (plus the
// zoned-fields conversion trio), recurrence expansion, and the full
// sync-adapter serialization contract (item + calendar ops/parsers/constants).
// Date-string plumbing used internally by recurrence expansion stays private.
export { Calendar } from "./calendar";
export {
  addDaysInZone,
  addMonthsInZone,
  dayRange,
  getTimeZoneOffsetMs,
  isSameDayInZone,
  monthGrid,
  startOfDayInZone,
  startOfMonthInZone,
  startOfWeekInZone,
  utcToZonedFields,
  weekRange,
  zonedFieldsToUtc,
} from "./datetime";
export { expandOccurrences } from "./recurrence";
export {
  CALENDAR_NS,
  CALENDARS_COLLECTION,
  ITEMS_COLLECTION,
  addExdateOp,
  calendarToMetadata,
  createCalendarOp,
  createItemOp,
  deleteCalendarOp,
  deleteItemOp,
  itemToMetadata,
  newId,
  parseCalendar,
  parseCalendarItem,
  setOverrideOp,
  updateCalendarOp,
  updateItemOp,
} from "./sync-adapter";
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
