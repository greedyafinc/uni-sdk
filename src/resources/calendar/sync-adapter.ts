// Bridges calendar items/calendars to the sync engine's metadata bags and ops.
// Deliberately imports ONLY the SyncOp type — never the Sync/WorkspaceSync
// classes — so this module stays pure. Apps wire the ops into a workspace:
//   workspace.apply([createItemOp(item)])
//   workspace.collection(CALENDAR_NS, ITEMS_COLLECTION).list()
//     .map((r) => parseCalendarItem(r.metadata))

import type { SyncOp } from "../sync/types";
import { asBool, asNumber, asObject, asString, asStringArray } from "./_internal/guards";
import type {
  CalendarItem,
  CalendarItemFields,
  CalendarItemKind,
  CalendarMeta,
  Frequency,
  ItemLink,
  NthWeekday,
  OccurrenceOverride,
  RecurrenceRule,
  Weekday,
} from "./types";

export const CALENDAR_NS = "calendar" as const;
export const ITEMS_COLLECTION = "items" as const;
export const CALENDARS_COLLECTION = "calendars" as const;

/** Browser-safe UUID v4 — crypto.randomUUID when available, Math.random fallback. */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ─── Serialization ────────────────────────────────────────────────────────────

function dropUndefined(bag: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bag)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Plain-JSON metadata bag for a calendar item (undefined keys dropped). */
export function itemToMetadata(item: CalendarItem): Record<string, unknown> {
  return dropUndefined({ ...item });
}

/** Plain-JSON metadata bag for a calendar container (undefined keys dropped). */
export function calendarToMetadata(cal: CalendarMeta): Record<string, unknown> {
  return dropUndefined({ ...cal });
}

// ─── Tolerant parsing ─────────────────────────────────────────────────────────

const KINDS: readonly CalendarItemKind[] = ["event", "task", "milestone", "log"];
const FREQS: readonly Frequency[] = ["daily", "weekly", "monthly", "yearly"];
const WEEKDAYS: readonly Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asWeekday(v: unknown): Weekday | undefined {
  return typeof v === "string" && (WEEKDAYS as readonly string[]).includes(v)
    ? (v as Weekday)
    : undefined;
}

function parseRecurrence(v: unknown): RecurrenceRule | undefined {
  const obj = asObject(v);
  if (!obj) return undefined;
  const freq = asString(obj.freq);
  if (!freq || !(FREQS as readonly string[]).includes(freq)) return undefined;
  const rule: RecurrenceRule = { freq: freq as Frequency };
  const interval = asNumber(obj.interval);
  if (interval !== undefined) rule.interval = Math.max(1, Math.floor(interval));
  if (Array.isArray(obj.byDay)) {
    const byDay = obj.byDay.map(asWeekday).filter((w): w is Weekday => w !== undefined);
    if (byDay.length) rule.byDay = byDay;
  }
  if (Array.isArray(obj.byMonthDay)) {
    const byMonthDay = obj.byMonthDay.filter(
      (d): d is number =>
        typeof d === "number" && Number.isInteger(d) && d !== 0 && d >= -31 && d <= 31,
    );
    if (byMonthDay.length) rule.byMonthDay = byMonthDay;
  }
  if (Array.isArray(obj.byWeekday)) {
    const byWeekday: NthWeekday[] = [];
    for (const entry of obj.byWeekday) {
      const o = asObject(entry);
      if (!o) continue;
      const nth = asNumber(o.nth);
      const weekday = asWeekday(o.weekday);
      if (nth === undefined || !Number.isInteger(nth) || nth === 0 || nth < -5 || nth > 5) {
        continue;
      }
      if (!weekday) continue;
      byWeekday.push({ nth, weekday });
    }
    if (byWeekday.length) rule.byWeekday = byWeekday;
  }
  const until = asString(obj.until);
  if (until !== undefined && DATE_RE.test(until)) rule.until = until;
  const count = asNumber(obj.count);
  if (count !== undefined && count >= 1) rule.count = Math.floor(count);
  return rule;
}

function parseOverrides(v: unknown): OccurrenceOverride[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: OccurrenceOverride[] = [];
  for (const entry of v) {
    const o = asObject(entry);
    if (!o) continue;
    const originalStart = asString(o.originalStart);
    if (originalStart === undefined) continue;
    const ov: OccurrenceOverride = { originalStart };
    const deleted = asBool(o.deleted);
    if (deleted !== undefined) ov.deleted = deleted;
    const patch = asObject(o.patch);
    if (patch !== undefined) ov.patch = patch as Partial<CalendarItemFields>;
    out.push(ov);
  }
  return out.length ? out : undefined;
}

function parseLinks(v: unknown): ItemLink[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ItemLink[] = [];
  for (const entry of v) {
    const o = asObject(entry);
    if (!o) continue;
    const type = asString(o.type);
    const value = asString(o.value);
    if ((type !== "conversation" && type !== "url" && type !== "entity") || value === undefined) {
      continue;
    }
    const link: ItemLink = { type, value };
    const label = asString(o.label);
    if (label !== undefined) link.label = label;
    out.push(link);
  }
  return out.length ? out : undefined;
}

/**
 * Parse a metadata bag back into a CalendarItem. Tolerant: unknown keys are
 * ignored, malformed optional fields are dropped, malformed recurrence yields a
 * valid single item. Returns null only when required fields are missing/wrong.
 */
export function parseCalendarItem(metadata: Record<string, unknown>): CalendarItem | null {
  const id = asString(metadata.id);
  const calendarId = asString(metadata.calendarId);
  const timeZone = asString(metadata.timeZone);
  const allDay = asBool(metadata.allDay);
  const createdAt = asNumber(metadata.createdAt);
  const updatedAt = asNumber(metadata.updatedAt);
  if (
    id === undefined ||
    calendarId === undefined ||
    timeZone === undefined ||
    allDay === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return null;
  }
  const title = asString(metadata.title) ?? "";
  const rawKind = asString(metadata.kind);
  const kind: CalendarItemKind = (KINDS as readonly string[]).includes(rawKind ?? "")
    ? (rawKind as CalendarItemKind)
    : "event";

  let base: CalendarItem;
  if (allDay) {
    const startDate = asString(metadata.startDate);
    const endDate = asString(metadata.endDate);
    if (
      startDate === undefined ||
      endDate === undefined ||
      !DATE_RE.test(startDate) ||
      !DATE_RE.test(endDate)
    ) {
      return null;
    }
    base = {
      id,
      calendarId,
      kind,
      timeZone,
      allDay: true,
      title,
      startDate,
      endDate,
      createdAt,
      updatedAt,
    };
  } else {
    const start = asNumber(metadata.start);
    let end = asNumber(metadata.end);
    if (start === undefined || end === undefined) return null;
    if (end < start) end = start; // repair inverted intervals
    base = {
      id,
      calendarId,
      kind,
      timeZone,
      allDay: false,
      title,
      start,
      end,
      createdAt,
      updatedAt,
    };
  }

  const recurrence = parseRecurrence(metadata.recurrence);
  if (recurrence !== undefined) base.recurrence = recurrence;
  const exdates = asStringArray(metadata.exdates);
  if (exdates?.length) base.exdates = exdates;
  const overrides = parseOverrides(metadata.overrides);
  if (overrides !== undefined) base.overrides = overrides;
  const links = parseLinks(metadata.links);
  if (links !== undefined) base.links = links;
  const tags = asStringArray(metadata.tags);
  if (tags?.length) base.tags = tags;
  const color = asString(metadata.color);
  if (color !== undefined) base.color = color;
  const location = asString(metadata.location);
  if (location !== undefined) base.location = location;
  const description = asString(metadata.description);
  if (description !== undefined) base.description = description;
  const done = asBool(metadata.done);
  if (done !== undefined) base.done = done;
  const completedAt = asNumber(metadata.completedAt);
  if (completedAt !== undefined) base.completedAt = completedAt;
  return base;
}

/** Parse a metadata bag back into a CalendarMeta; null when required fields are missing. */
export function parseCalendar(metadata: Record<string, unknown>): CalendarMeta | null {
  const id = asString(metadata.id);
  const name = asString(metadata.name);
  const createdAt = asNumber(metadata.createdAt);
  const updatedAt = asNumber(metadata.updatedAt);
  if (
    id === undefined ||
    name === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return null;
  }
  const cal: CalendarMeta = { id, name, createdAt, updatedAt };
  const color = asString(metadata.color);
  if (color !== undefined) cal.color = color;
  const timeZone = asString(metadata.timeZone);
  if (timeZone !== undefined) cal.timeZone = timeZone;
  const hidden = asBool(metadata.hidden);
  if (hidden !== undefined) cal.hidden = hidden;
  return cal;
}

// ─── Op builders ──────────────────────────────────────────────────────────────

export function createItemOp(item: CalendarItem): SyncOp {
  return {
    ns: CALENDAR_NS,
    collection: ITEMS_COLLECTION,
    id: item.id,
    replace: itemToMetadata(item),
  };
}

/** Shallow-merge patch; nested arrays (overrides, exdates, …) must be passed whole. */
export function updateItemOp(id: string, patch: Record<string, unknown>): SyncOp {
  return { ns: CALENDAR_NS, collection: ITEMS_COLLECTION, id, patch };
}

export function deleteItemOp(id: string): SyncOp {
  return { ns: CALENDAR_NS, collection: ITEMS_COLLECTION, id, delete: true };
}

/** Merge `override` into the item's overrides by originalStart (replace or append). */
export function setOverrideOp(item: CalendarItem, override: OccurrenceOverride): SyncOp {
  const existing = item.overrides ?? [];
  const idx = existing.findIndex((o) => o.originalStart === override.originalStart);
  const next =
    idx >= 0 ? existing.map((o, i) => (i === idx ? override : o)) : [...existing, override];
  return updateItemOp(item.id, { overrides: next, updatedAt: Date.now() });
}

/** Union `key` into the item's exdates (no duplicates). */
export function addExdateOp(item: CalendarItem, key: string): SyncOp {
  const existing = item.exdates ?? [];
  const next = existing.includes(key) ? existing : [...existing, key];
  return updateItemOp(item.id, { exdates: next, updatedAt: Date.now() });
}

export function createCalendarOp(cal: CalendarMeta): SyncOp {
  return {
    ns: CALENDAR_NS,
    collection: CALENDARS_COLLECTION,
    id: cal.id,
    replace: calendarToMetadata(cal),
  };
}

export function updateCalendarOp(id: string, patch: Record<string, unknown>): SyncOp {
  return { ns: CALENDAR_NS, collection: CALENDARS_COLLECTION, id, patch };
}

export function deleteCalendarOp(id: string): SyncOp {
  return { ns: CALENDAR_NS, collection: CALENDARS_COLLECTION, id, delete: true };
}
