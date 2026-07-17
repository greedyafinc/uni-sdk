import { describe, expect, test } from "bun:test";
import { UnifiedAI } from "../../src/core/client";
import {
  type AllDayItem,
  CALENDARS_COLLECTION,
  CALENDAR_NS,
  ITEMS_COLLECTION,
  type TimedItem,
  addExdateOp,
  createCalendarOp,
  createItemOp,
  deleteItemOp,
  itemToMetadata,
  newId,
  parseCalendarItem,
  setOverrideOp,
  updateItemOp,
} from "../../src/resources/calendar";
import { FakeSyncServer } from "../../src/resources/sync";

const NY = "America/New_York";

function timedItem(over: Partial<TimedItem> = {}): TimedItem {
  return {
    id: "it1",
    calendarId: "c1",
    kind: "event",
    timeZone: NY,
    allDay: false,
    title: "Standup",
    start: Date.UTC(2026, 0, 5, 14),
    end: Date.UTC(2026, 0, 5, 15),
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

describe("calendar sync-adapter — serialization round-trips", () => {
  test("timed recurring item with overrides/exdates/links/tags round-trips", () => {
    const item = timedItem({
      kind: "task",
      description: "daily standup",
      location: "Room 1",
      color: "#ff0000",
      tags: ["work", "recurring"],
      links: [{ type: "conversation", value: "conv-1", label: "notes" }],
      done: false,
      recurrence: { freq: "weekly", interval: 2, byDay: ["MO", "WE"], count: 10 },
      exdates: [String(Date.UTC(2026, 0, 7, 14))],
      overrides: [
        { originalStart: String(Date.UTC(2026, 0, 5, 14)), patch: { title: "Moved" } },
        { originalStart: String(Date.UTC(2026, 0, 19, 14)), deleted: true },
      ],
    });
    const parsed = parseCalendarItem(itemToMetadata(item));
    expect(parsed).toEqual(item);
  });

  test("all-day item round-trips", () => {
    const item: AllDayItem = {
      id: "trip1",
      calendarId: "c1",
      kind: "event",
      timeZone: NY,
      allDay: true,
      title: "Trip",
      startDate: "2026-07-10",
      endDate: "2026-07-12",
      createdAt: 1000,
      updatedAt: 2000,
    };
    expect(parseCalendarItem(itemToMetadata(item))).toEqual(item);
  });
});

describe("calendar sync-adapter — tolerant parsing", () => {
  test("unknown keys are dropped", () => {
    const bag = { ...itemToMetadata(timedItem()), zombieField: "brains", extra: 42 };
    const parsed = parseCalendarItem(bag);
    expect(parsed).toEqual(timedItem());
    expect(parsed && "zombieField" in parsed).toBe(false);
  });

  test("missing timeZone → null", () => {
    const { timeZone: _dropped, ...bag } = itemToMetadata(timedItem());
    expect(parseCalendarItem(bag)).toBeNull();
  });

  test("end < start is repaired to end = start", () => {
    const bag = itemToMetadata(timedItem({ start: 2000, end: 3000 }));
    bag.end = 500;
    const parsed = parseCalendarItem(bag);
    expect(parsed?.allDay).toBe(false);
    expect(parsed && !parsed.allDay && parsed.end).toBe(2000);
  });

  test("malformed recurrence yields a valid single (non-recurring) item", () => {
    const bag = itemToMetadata(timedItem());
    bag.recurrence = { freq: "fortnightly", interval: "x" }; // bad freq → dropped
    const parsed = parseCalendarItem(bag);
    expect(parsed).not.toBeNull();
    expect(parsed?.recurrence).toBeUndefined();
  });
});

describe("calendar sync-adapter — op builders", () => {
  test("create → replace, update → patch, delete → delete:true with correct addressing", () => {
    const item = timedItem();
    const create = createItemOp(item);
    expect(create.ns).toBe(CALENDAR_NS);
    expect(create.collection).toBe(ITEMS_COLLECTION);
    expect(create.id).toBe("it1");
    expect(create.replace).toEqual(itemToMetadata(item));
    expect(create.patch).toBeUndefined();
    expect(create.delete).toBeUndefined();

    const update = updateItemOp("it1", { title: "Renamed" });
    expect(update).toEqual({
      ns: CALENDAR_NS,
      collection: ITEMS_COLLECTION,
      id: "it1",
      patch: { title: "Renamed" },
    });

    const del = deleteItemOp("it1");
    expect(del).toEqual({
      ns: CALENDAR_NS,
      collection: ITEMS_COLLECTION,
      id: "it1",
      delete: true,
    });

    const cal = createCalendarOp({ id: "c1", name: "Work", createdAt: 1, updatedAt: 1 });
    expect(cal.collection).toBe(CALENDARS_COLLECTION);
    expect(cal.replace).toEqual({ id: "c1", name: "Work", createdAt: 1, updatedAt: 1 });
  });

  test("setOverrideOp replaces same-originalStart and appends new; full array in patch", () => {
    const key1 = String(Date.UTC(2026, 0, 5, 14));
    const key2 = String(Date.UTC(2026, 0, 12, 14));
    const item = timedItem({
      overrides: [{ originalStart: key1, patch: { title: "Old" } }],
    });
    // Same key → replaced in place, no duplicate.
    const replaced = setOverrideOp(item, { originalStart: key1, patch: { title: "New" } });
    expect(replaced.patch?.overrides).toEqual([{ originalStart: key1, patch: { title: "New" } }]);
    // New key → appended after the existing one.
    const appended = setOverrideOp(item, { originalStart: key2, deleted: true });
    expect(appended.patch?.overrides).toEqual([
      { originalStart: key1, patch: { title: "Old" } },
      { originalStart: key2, deleted: true },
    ]);
    expect(typeof appended.patch?.updatedAt).toBe("number");
  });

  test("addExdateOp unions without duplicating", () => {
    const key = String(Date.UTC(2026, 0, 7, 14));
    const fresh = addExdateOp(timedItem(), key);
    expect(fresh.patch?.exdates).toEqual([key]);
    const dup = addExdateOp(timedItem({ exdates: [key] }), key);
    expect(dup.patch?.exdates).toEqual([key]);
    const union = addExdateOp(timedItem({ exdates: ["other"] }), key);
    expect(union.patch?.exdates).toEqual(["other", key]);
  });

  test("newId returns unique UUID-shaped ids", () => {
    const a = newId();
    const b = newId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("calendar sync-adapter — FakeSyncServer round-trip", () => {
  test("apply(createItemOp) then read back and parse deep-equals the original", async () => {
    const server = new FakeSyncServer();
    const sdk = new UnifiedAI({
      apiUrl: server.baseUrl,
      token: "t",
      fetch: server.fetch as unknown as typeof fetch,
    });
    const ws = sdk.sync.workspace("ws");
    await ws.sync();

    const item = timedItem({
      recurrence: { freq: "daily", count: 5 },
      exdates: [String(Date.UTC(2026, 0, 7, 14))],
      overrides: [{ originalStart: String(Date.UTC(2026, 0, 6, 14)), patch: { title: "Moved" } }],
      tags: ["work"],
    });
    await ws.apply([createItemOp(item)]);

    const rec = ws.collection(CALENDAR_NS, ITEMS_COLLECTION).get(item.id);
    expect(rec).not.toBeNull();
    expect(rec && parseCalendarItem(rec.metadata)).toEqual(item);
    await ws.stop();
  });
});
