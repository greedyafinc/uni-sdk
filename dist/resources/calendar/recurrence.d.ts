import type { CalendarItem, ExpandOptions, Occurrence } from "./types.js";
/**
 * Expand `item` into concrete occurrences overlapping `[rangeStart, rangeEnd)`,
 * sorted ascending by effective start. Handles non-recurring items, all four
 * frequencies, EXDATEs, per-instance overrides (moved/deleted), and detached
 * overrides whose cadence slot lies beyond the window.
 */
export declare function expandOccurrences(item: CalendarItem, rangeStart: number, rangeEnd: number, opts?: ExpandOptions): Occurrence[];
//# sourceMappingURL=recurrence.d.ts.map