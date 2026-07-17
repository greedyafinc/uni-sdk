import { describe, expect, test } from "bun:test";
import {
  type AllDayItem,
  type TimedItem,
  expandOccurrences,
  utcToZonedFields,
} from "../../src/resources/calendar";

const NY = "America/New_York";
const HOUR = 3_600_000;
const DAY = 86_400_000;

// Anchor: Monday 2026-01-05 09:00–10:00 America/New_York (EST, UTC-5).
const ANCHOR_START = Date.UTC(2026, 0, 5, 14);
const ANCHOR_END = Date.UTC(2026, 0, 5, 15);
const YEAR_2026: [number, number] = [Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)];

function timedItem(over: Partial<TimedItem> = {}): TimedItem {
  return {
    id: "it1",
    calendarId: "c1",
    kind: "event",
    timeZone: NY,
    allDay: false,
    title: "T",
    start: ANCHOR_START,
    end: ANCHOR_END,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("expandOccurrences — basic cadences", () => {
  test("daily count:5 → exactly 5, ascending, one local day apart", () => {
    const item = timedItem({ recurrence: { freq: "daily", count: 5 } });
    const occ = expandOccurrences(item, ...YEAR_2026);
    expect(occ).toHaveLength(5);
    expect(occ.map((o) => o.start)).toEqual([
      Date.UTC(2026, 0, 5, 14),
      Date.UTC(2026, 0, 6, 14),
      Date.UTC(2026, 0, 7, 14),
      Date.UTC(2026, 0, 8, 14),
      Date.UTC(2026, 0, 9, 14),
    ]);
    for (const o of occ) expect(o.end - o.start).toBe(HOUR);
  });

  test("daily interval:3 spaces occurrences 3 days apart", () => {
    const item = timedItem({ recurrence: { freq: "daily", interval: 3, count: 4 } });
    const starts = expandOccurrences(item, ...YEAR_2026).map((o) => o.start);
    expect(starts).toEqual([
      ANCHOR_START,
      ANCHOR_START + 3 * DAY,
      ANCHOR_START + 6 * DAY,
      ANCHOR_START + 9 * DAY,
    ]);
  });

  test("weekly byDay [MO,WE,FR] with inclusive until", () => {
    const item = timedItem({
      recurrence: { freq: "weekly", byDay: ["MO", "WE", "FR"], until: "2026-01-16" },
    });
    const starts = expandOccurrences(item, ...YEAR_2026).map((o) => o.start);
    expect(starts).toEqual([
      Date.UTC(2026, 0, 5, 14), // Mon
      Date.UTC(2026, 0, 7, 14), // Wed
      Date.UTC(2026, 0, 9, 14), // Fri
      Date.UTC(2026, 0, 12, 14), // Mon
      Date.UTC(2026, 0, 14, 14), // Wed
      Date.UTC(2026, 0, 16, 14), // Fri — until is inclusive
    ]);
    // The day before excludes the Friday.
    const shorter = timedItem({
      recurrence: { freq: "weekly", byDay: ["MO", "WE", "FR"], until: "2026-01-15" },
    });
    expect(expandOccurrences(shorter, ...YEAR_2026)).toHaveLength(5);
  });
});

describe("expandOccurrences — DST", () => {
  test("weekly 09:00 NY across spring-forward keeps 09:00 local; UTC shifts 1h", () => {
    const item = timedItem({
      start: Date.UTC(2026, 2, 2, 14), // Mon 2026-03-02 09:00 EST
      end: Date.UTC(2026, 2, 2, 15),
      recurrence: { freq: "weekly", count: 3 },
    });
    const occ = expandOccurrences(item, Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1));
    expect(occ.map((o) => o.start)).toEqual([
      Date.UTC(2026, 2, 2, 14), // EST
      Date.UTC(2026, 2, 9, 13), // EDT — transition was 2026-03-08
      Date.UTC(2026, 2, 16, 13),
    ]);
    for (const o of occ) expect(utcToZonedFields(o.start, NY).hour).toBe(9);
  });

  test("fall-back: 01:30 on 2026-11-01 NY resolves to the earlier (-4h) instant", () => {
    const item = timedItem({
      start: Date.UTC(2026, 9, 31, 5, 30), // Sat 2026-10-31 01:30 EDT
      end: Date.UTC(2026, 9, 31, 6, 30),
      recurrence: { freq: "daily", count: 2 },
    });
    const occ = expandOccurrences(item, Date.UTC(2026, 9, 1), Date.UTC(2026, 11, 1));
    expect(occ).toHaveLength(2);
    expect(occ[1]?.start).toBe(Date.UTC(2026, 10, 1, 5, 30)); // 01:30-04:00, first pass
  });
});

describe("expandOccurrences — monthly / yearly skip semantics", () => {
  test("monthly byMonthDay [31] SKIPS 30-day months and February", () => {
    const item = timedItem({
      start: Date.UTC(2026, 0, 31, 15), // 2026-01-31 10:00 EST
      end: Date.UTC(2026, 0, 31, 16),
      recurrence: { freq: "monthly", byMonthDay: [31] },
    });
    const months = expandOccurrences(item, ...YEAR_2026).map(
      (o) => utcToZonedFields(o.start, NY).month,
    );
    expect(months).toEqual([1, 3, 5, 7, 8, 10, 12]);
  });

  test("monthly nth-weekday {3, MO}", () => {
    const item = timedItem({
      start: Date.UTC(2026, 0, 19, 14), // 3rd Monday of Jan 2026, 09:00 EST
      end: Date.UTC(2026, 0, 19, 15),
      recurrence: { freq: "monthly", byWeekday: [{ nth: 3, weekday: "MO" }] },
    });
    const occ = expandOccurrences(item, Date.UTC(2026, 0, 1), Date.UTC(2026, 3, 1));
    expect(occ.map((o) => o.start)).toEqual([
      Date.UTC(2026, 0, 19, 14), // Jan 19
      Date.UTC(2026, 1, 16, 14), // Feb 16
      Date.UTC(2026, 2, 16, 13), // Mar 16 (EDT)
    ]);
  });

  test("monthly nth-weekday {-1, FR} = last Friday", () => {
    const item = timedItem({
      start: Date.UTC(2026, 0, 30, 14), // last Friday of Jan 2026
      end: Date.UTC(2026, 0, 30, 15),
      recurrence: { freq: "monthly", byWeekday: [{ nth: -1, weekday: "FR" }] },
    });
    const occ = expandOccurrences(item, Date.UTC(2026, 0, 1), Date.UTC(2026, 3, 1));
    expect(occ.map((o) => o.start)).toEqual([
      Date.UTC(2026, 0, 30, 14), // Jan 30
      Date.UTC(2026, 1, 27, 14), // Feb 27
      Date.UTC(2026, 2, 27, 13), // Mar 27 (EDT)
    ]);
  });

  test("monthly nth-weekday {5, FR} skips months without a 5th Friday", () => {
    const item = timedItem({
      start: Date.UTC(2026, 0, 30, 14), // 5th Friday of Jan 2026
      end: Date.UTC(2026, 0, 30, 15),
      recurrence: { freq: "monthly", byWeekday: [{ nth: 5, weekday: "FR" }] },
    });
    const occ = expandOccurrences(item, Date.UTC(2026, 0, 1), Date.UTC(2026, 5, 1));
    // Feb/Mar/Apr 2026 have only 4 Fridays; May 29 is the next 5th Friday.
    expect(occ.map((o) => o.start)).toEqual([Date.UTC(2026, 0, 30, 14), Date.UTC(2026, 4, 29, 13)]);
  });

  test("yearly Feb-29 anchor recurs on leap years only", () => {
    const item = timedItem({
      timeZone: "UTC",
      start: Date.UTC(2024, 1, 29, 12),
      end: Date.UTC(2024, 1, 29, 13),
      recurrence: { freq: "yearly" },
    });
    const occ = expandOccurrences(item, Date.UTC(2024, 0, 1), Date.UTC(2029, 0, 1));
    expect(occ.map((o) => o.start)).toEqual([Date.UTC(2024, 1, 29, 12), Date.UTC(2028, 1, 29, 12)]);
  });
});

describe("expandOccurrences — EXDATE and COUNT interaction", () => {
  const jan7Key = String(Date.UTC(2026, 0, 7, 14));

  test("COUNT is consumed BEFORE exdate removal: count:5 + 1 exdate → 4 emitted", () => {
    const item = timedItem({
      recurrence: { freq: "daily", count: 5 },
      exdates: [jan7Key],
    });
    const starts = expandOccurrences(item, ...YEAR_2026).map((o) => o.start);
    expect(starts).toHaveLength(4);
    // The series still ends at the 5th cadence slot (Jan 9), not Jan 10.
    expect(starts[starts.length - 1]).toBe(Date.UTC(2026, 0, 9, 14));
    expect(starts).not.toContain(Date.UTC(2026, 0, 7, 14));
  });

  test("EXDATE removes exactly the targeted occurrence", () => {
    const item = timedItem({
      recurrence: { freq: "daily", until: "2026-01-09" },
      exdates: [jan7Key],
    });
    const starts = expandOccurrences(item, ...YEAR_2026).map((o) => o.start);
    expect(starts).toEqual([
      Date.UTC(2026, 0, 5, 14),
      Date.UTC(2026, 0, 6, 14),
      Date.UTC(2026, 0, 8, 14),
      Date.UTC(2026, 0, 9, 14),
    ]);
  });
});

describe("expandOccurrences — overrides", () => {
  const jan6Original = Date.UTC(2026, 0, 6, 14);
  const jan6Key = String(jan6Original);

  test("modify override moves time + title; identity keyed by the original slot", () => {
    const item = timedItem({
      recurrence: { freq: "daily", count: 3 },
      overrides: [
        {
          originalStart: jan6Key,
          patch: {
            start: jan6Original + 2 * HOUR,
            end: jan6Original + 3 * HOUR,
            title: "Moved",
          },
        },
      ],
    });
    const occ = expandOccurrences(item, ...YEAR_2026);
    expect(occ).toHaveLength(3);
    const moved = occ.find((o) => o.isOverride);
    expect(moved?.start).toBe(jan6Original + 2 * HOUR);
    expect(moved?.end).toBe(jan6Original + 3 * HOUR);
    expect(moved?.title).toBe("Moved");
    expect(moved?.originalStart).toBe(jan6Original);
    expect(moved?.occurrenceKey).toBe(`it1::${jan6Key}`);
    // Siblings unchanged.
    const siblings = occ.filter((o) => !o.isOverride);
    expect(siblings.map((o) => o.start)).toEqual([
      Date.UTC(2026, 0, 5, 14),
      Date.UTC(2026, 0, 7, 14),
    ]);
    for (const s of siblings) expect(s.title).toBe("T");
  });

  test("deleted override removes the instance", () => {
    const item = timedItem({
      recurrence: { freq: "daily", count: 3 },
      overrides: [{ originalStart: jan6Key, deleted: true }],
    });
    const starts = expandOccurrences(item, ...YEAR_2026).map((o) => o.start);
    expect(starts).toEqual([Date.UTC(2026, 0, 5, 14), Date.UTC(2026, 0, 7, 14)]);
  });

  test("detached override: slot beyond rangeEnd, patched time inside the window", () => {
    const jan20Original = Date.UTC(2026, 0, 20, 14);
    const item = timedItem({
      recurrence: { freq: "daily", count: 30 },
      overrides: [
        {
          originalStart: String(jan20Original),
          patch: { start: Date.UTC(2026, 0, 8, 20), end: Date.UTC(2026, 0, 8, 21) },
        },
      ],
    });
    const occ = expandOccurrences(item, Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 10));
    // Jan 5..9 from the cadence + the detached Jan 20 override moved to Jan 8.
    expect(occ).toHaveLength(6);
    const detached = occ.find((o) => o.isOverride);
    expect(detached?.start).toBe(Date.UTC(2026, 0, 8, 20));
    expect(detached?.originalStart).toBe(jan20Original);
    expect(detached?.occurrenceKey).toBe(`it1::${jan20Original}`);
  });
});

describe("expandOccurrences — all-day and non-recurring", () => {
  test("multi-day all-day trip is returned for a window covering only its middle day", () => {
    const trip: AllDayItem = {
      id: "trip1",
      calendarId: "c1",
      kind: "event",
      timeZone: NY,
      allDay: true,
      title: "Trip",
      startDate: "2026-07-10",
      endDate: "2026-07-12",
      createdAt: 0,
      updatedAt: 0,
    };
    // Window = just 2026-07-11 local NY.
    const occ = expandOccurrences(trip, Date.UTC(2026, 6, 11, 4), Date.UTC(2026, 6, 12, 4));
    expect(occ).toHaveLength(1);
    expect(occ[0]?.allDay).toBe(true);
    expect(occ[0]?.startDate).toBe("2026-07-10");
    expect(occ[0]?.endDate).toBe("2026-07-12");
    expect(occ[0]?.start).toBe(Date.UTC(2026, 6, 10, 4)); // 00:00 EDT on the 10th
    expect(occ[0]?.end).toBe(Date.UTC(2026, 6, 13, 4)); // exclusive: 00:00 on the 13th
    expect(occ[0]?.occurrenceKey).toBe("trip1::2026-07-10");
  });

  test("non-recurring: included iff it overlaps the window", () => {
    const item = timedItem(); // 09:00–10:00 Jan 5
    expect(expandOccurrences(item, ...YEAR_2026)).toHaveLength(1);
    // Window starting exactly at the item's exclusive end → no overlap.
    expect(expandOccurrences(item, ANCHOR_END, ANCHOR_END + DAY)).toHaveLength(0);
    // Window ending exactly at the item's start → no overlap ([start, end)).
    expect(expandOccurrences(item, ANCHOR_START - DAY, ANCHOR_START)).toHaveLength(0);
    // Partial overlap counts.
    expect(expandOccurrences(item, ANCHOR_START + 1, ANCHOR_START + 2)).toHaveLength(1);
  });
});

describe("expandOccurrences — bounds and identity", () => {
  test("long rule + narrow window stays bounded and returns only the window's slots", () => {
    const item = timedItem({
      start: Date.UTC(2026, 0, 15, 14),
      end: Date.UTC(2026, 0, 15, 15),
      recurrence: { freq: "monthly", until: "2076-01-15" }, // 50 years out
    });
    const startedAt = Date.now();
    const occ = expandOccurrences(item, Date.UTC(2030, 2, 1), Date.UTC(2030, 3, 1));
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(occ).toHaveLength(1);
    expect(utcToZonedFields(occ[0]?.start ?? 0, NY)).toMatchObject({
      year: 2030,
      month: 3,
      day: 15,
    });
  });

  test("occurrenceKey is stable across expansions with different windows", () => {
    const item = timedItem({ recurrence: { freq: "daily", count: 10 } });
    const narrow = expandOccurrences(item, Date.UTC(2026, 0, 7), Date.UTC(2026, 0, 8));
    const wide = expandOccurrences(item, ...YEAR_2026);
    expect(narrow).toHaveLength(1);
    const key = narrow[0]?.occurrenceKey;
    expect(key).toBe(`it1::${Date.UTC(2026, 0, 7, 14)}`);
    expect(wide.find((o) => o.start === Date.UTC(2026, 0, 7, 14))?.occurrenceKey).toBe(key);
  });
});
