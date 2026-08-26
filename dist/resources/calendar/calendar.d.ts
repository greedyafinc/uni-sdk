import type { SyncOp } from "../sync/types.js";
import type { CalendarItem, DayCell, ExpandOptions, Occurrence, OccurrenceOverride, Range, Weekday } from "./types.js";
export declare class Calendar {
    monthGrid(year: number, month: number, tz: string, weekStart?: Weekday): DayCell[];
    weekRange(epochMs: number, tz: string, weekStart?: Weekday): Range;
    dayRange(epochMs: number, tz: string): Range;
    startOfDay(epochMs: number, tz: string): number;
    startOfWeek(epochMs: number, tz: string, weekStart?: Weekday): number;
    startOfMonth(epochMs: number, tz: string): number;
    addDays(epochMs: number, days: number, tz: string): number;
    addMonths(epochMs: number, months: number, tz: string): number;
    isSameDay(a: number, b: number, tz: string): boolean;
    expand(item: CalendarItem, rangeStart: number, rangeEnd: number, opts?: ExpandOptions): Occurrence[];
    newId(): string;
    toMetadata(item: CalendarItem): Record<string, unknown>;
    parseItem(metadata: Record<string, unknown>): CalendarItem | null;
    createItemOp(item: CalendarItem): SyncOp;
    updateItemOp(id: string, patch: Record<string, unknown>): SyncOp;
    deleteItemOp(id: string): SyncOp;
    setOverrideOp(item: CalendarItem, override: OccurrenceOverride): SyncOp;
    addExdateOp(item: CalendarItem, key: string): SyncOp;
}
//# sourceMappingURL=calendar.d.ts.map