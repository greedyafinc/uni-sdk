import { describe, expect, test } from "bun:test";
import {
  addDaysInZone,
  addMonthsInZone,
  dayRange,
  getTimeZoneOffsetMs,
  monthGrid,
  startOfDayInZone,
  startOfWeekInZone,
  utcToZonedFields,
  weekRange,
  zonedFieldsToUtc,
} from "../../src/resources/calendar";

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("calendar datetime — offsets and field conversion", () => {
  test("getTimeZoneOffsetMs: NY winter is -5h, NY summer is -4h", () => {
    expect(getTimeZoneOffsetMs(Date.UTC(2026, 0, 15, 12), NY)).toBe(-5 * HOUR);
    expect(getTimeZoneOffsetMs(Date.UTC(2026, 6, 15, 12), NY)).toBe(-4 * HOUR);
  });

  test("utcToZonedFields: known wall-clock in NY and Tokyo", () => {
    const instant = Date.UTC(2026, 0, 15, 12, 34, 56); // 2026-01-15T12:34:56Z
    expect(utcToZonedFields(instant, NY)).toEqual({
      year: 2026,
      month: 1,
      day: 15,
      hour: 7,
      minute: 34,
      second: 56,
    });
    expect(utcToZonedFields(instant, TOKYO)).toEqual({
      year: 2026,
      month: 1,
      day: 15,
      hour: 21,
      minute: 34,
      second: 56,
    });
  });

  test("zonedFieldsToUtc round-trips utcToZonedFields, incl. near a DST boundary", () => {
    const instants = [
      Date.UTC(2026, 0, 15, 12), // deep winter
      Date.UTC(2026, 6, 15, 12), // deep summer
      Date.UTC(2026, 2, 8, 6, 30), // 01:30 EST, 30 min before spring-forward
      Date.UTC(2026, 2, 8, 7, 30), // 03:30 EDT, just after spring-forward
      Date.UTC(2026, 10, 1, 4, 30), // 00:30 EDT, before fall-back
      Date.UTC(2026, 10, 1, 7, 30), // 02:30 EST, after fall-back
    ];
    for (const t of instants) {
      expect(zonedFieldsToUtc(utcToZonedFields(t, NY), NY)).toBe(t);
      expect(zonedFieldsToUtc(utcToZonedFields(t, TOKYO), TOKYO)).toBe(t);
    }
  });
});

describe("calendar datetime — day boundaries across DST", () => {
  test("normal day is exactly 24h", () => {
    const r = dayRange(Date.UTC(2026, 0, 15, 12), NY);
    expect(r.start).toBe(Date.UTC(2026, 0, 15, 5)); // 2026-01-15T00:00-05:00
    expect(r.end - r.start).toBe(24 * HOUR);
  });

  test("NY spring-forward day (2026-03-08) elapses 23h", () => {
    const r = dayRange(Date.UTC(2026, 2, 8, 12), NY);
    expect(r.start).toBe(Date.UTC(2026, 2, 8, 5)); // midnight EST
    expect(r.end).toBe(Date.UTC(2026, 2, 9, 4)); // next midnight EDT
    expect(r.end - r.start).toBe(23 * HOUR);
  });

  test("NY fall-back day (2026-11-01) elapses 25h", () => {
    const r = dayRange(Date.UTC(2026, 10, 1, 12), NY);
    expect(r.start).toBe(Date.UTC(2026, 10, 1, 4)); // midnight EDT
    expect(r.end).toBe(Date.UTC(2026, 10, 2, 5)); // next midnight EST
    expect(r.end - r.start).toBe(25 * HOUR);
  });

  test("startOfDayInZone matches dayRange start", () => {
    const t = Date.UTC(2026, 2, 8, 12);
    expect(startOfDayInZone(t, NY)).toBe(Date.UTC(2026, 2, 8, 5));
  });
});

describe("calendar datetime — wall-clock arithmetic", () => {
  test("addDaysInZone(+1) across spring-forward keeps local clock time", () => {
    const sat9am = Date.UTC(2026, 2, 7, 14); // 2026-03-07T09:00-05:00
    const next = addDaysInZone(sat9am, 1, NY);
    expect(next).toBe(Date.UTC(2026, 2, 8, 13)); // 2026-03-08T09:00-04:00
    expect(next - sat9am).toBe(23 * HOUR); // real elapsed time is 23h
    expect(utcToZonedFields(next, NY).hour).toBe(9);
  });

  test("addMonthsInZone clamps Jan 31 + 1mo to Feb 28 (2026 is not a leap year)", () => {
    const jan31 = Date.UTC(2026, 0, 31, 15); // 2026-01-31T10:00-05:00
    const next = addMonthsInZone(jan31, 1, NY);
    expect(utcToZonedFields(next, NY)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
      hour: 10,
      minute: 0,
      second: 0,
    });
  });
});

describe("calendar datetime — monthGrid", () => {
  test("July 2026 NY: 42 cells, MO-aligned leading days, 31 in-month", () => {
    const cells = monthGrid(2026, 7, NY);
    expect(cells).toHaveLength(42);
    // 2026-07-01 is a Wednesday → grid starts Monday 2026-06-29.
    expect(cells[0]?.date).toBe("2026-06-29");
    expect(cells[0]?.weekday).toBe("MO");
    expect(cells[0]?.inCurrentMonth).toBe(false);
    expect(cells[2]?.date).toBe("2026-07-01");
    expect(cells[2]?.inCurrentMonth).toBe(true);
    expect(cells.filter((c) => c.inCurrentMonth)).toHaveLength(31);
    // Cell instants are real day boundaries in tz.
    expect(cells[2]?.start).toBe(Date.UTC(2026, 6, 1, 4)); // 00:00 EDT
    expect(cells[2]?.end).toBe(Date.UTC(2026, 6, 2, 4));
  });

  test("a month needing the 6th row still returns 42 cells covering the month", () => {
    // 2026-08-01 is a Saturday → leading 5 + 31 days = 36 > 35 → 6 rows needed.
    const cells = monthGrid(2026, 8, NY);
    expect(cells).toHaveLength(42);
    expect(cells[0]?.date).toBe("2026-07-27");
    expect(cells.filter((c) => c.inCurrentMonth)).toHaveLength(31);
    expect(cells.some((c) => c.date === "2026-08-31")).toBe(true);
  });
});

describe("calendar datetime — week boundaries", () => {
  test("startOfWeekInZone honors weekStart MO vs SU", () => {
    const wedNoon = Date.UTC(2026, 6, 15, 16); // 2026-07-15 (Wed) 12:00 EDT
    expect(startOfWeekInZone(wedNoon, NY, "MO")).toBe(Date.UTC(2026, 6, 13, 4)); // Mon 07-13
    expect(startOfWeekInZone(wedNoon, NY, "SU")).toBe(Date.UTC(2026, 6, 12, 4)); // Sun 07-12
  });

  test("weekRange spans 7 local days", () => {
    const wedNoon = Date.UTC(2026, 6, 15, 16);
    const r = weekRange(wedNoon, NY, "MO");
    expect(r.start).toBe(Date.UTC(2026, 6, 13, 4));
    expect(r.end).toBe(Date.UTC(2026, 6, 20, 4));
    expect(r.end - r.start).toBe(7 * DAY);
  });
});
