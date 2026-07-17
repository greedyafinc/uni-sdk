// Tolerant coercion helpers for the metadata parser (private to the calendar
// module). Each returns the value if it has the expected shape, else undefined
// — parse functions decide whether a miss is fatal (required field) or ignorable.

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

export function asObject(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
