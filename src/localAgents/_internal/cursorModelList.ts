// Provider-agnostic "effort level" + "mode" model for chat, ported from the
// UnifiedApp desktop app's `@/lib/effort` (see that file for the full design
// note). Re-declared locally here since uni-sdk has no `@/lib/effort` alias
// and no dependency on `@unified/floating-chat`.

export interface EffortOption {
  id: string;
  label: string;
  modelId?: string;
  default?: boolean;
  hint?: string;
}

export interface ModeOption {
  id: string;
  label: string;
  hint?: string;
  param?: boolean;
  default?: boolean;
}

/** Model id per (effort, modes) combination, keyed by `variantKey`. */
export type VariantMap = Record<string, string>;

/** Stable key for a combination — modes are order-insensitive. */
export function variantKey(effortId: string | null | undefined, modeIds: string[]): string {
  return [effortId ?? "", ...[...modeIds].sort()].join("+");
}

/** Canonical ordering + labels for the common level vocabulary. */
export const EFFORT_LEVEL_LABELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "none", label: "None" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
];

function titleCase(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

export function effortLabel(id: string): string {
  return EFFORT_LEVEL_LABELS.find((l) => l.id === id)?.label ?? titleCase(id);
}

/** Labels/hints for known mode flags; anything else gets a title-cased id. */
const MODE_META: Record<string, { label: string; hint?: string }> = {
  fast: { label: "Fast", hint: "Prioritize speed over depth" },
  thinking: { label: "Thinking", hint: "Show extended reasoning" },
};

export function modeLabel(id: string): string {
  return MODE_META[id]?.label ?? titleCase(id);
}

export function modeHint(id: string): string | undefined {
  return MODE_META[id]?.hint;
}

// Parser for `cursor-agent models` output. The CLI documents the command ("List
// available models for this account") but not its output shape, so this is
// deliberately tolerant: structured JSON when present, otherwise a line-oriented
// text parse that recognizes the common "id — Name" / "Name (id)" layouts.
// Pure (no IPC) so it is unit-tested in isolation.

export interface CursorModelEntry {
  /** The id `--model` accepts, e.g. `composer-2.5`. */
  id: string;
  /** Human label; falls back to a prettified id. */
  name: string;
  /** True when the CLI marked it as the current default. */
  isDefault?: boolean;
  /**
   * Effort variants of this entry (same base + same mode flags, differing only in
   * the effort token), in canonical order. Present only when there are ≥ 2.
   */
  efforts?: CursorEffortVariant[];
  /** Mode flags available on top of the canonical variant, e.g. `["fast"]`. */
  modes?: CursorMode[];
  /** (effort, modes) → CLI id, keyed by `variantKey` from lib/effort. */
  variants?: Record<string, string>;
}

/** Mode flags (e.g. `fast`) offered as toggles, ordered for display. */
export type CursorMode = string;

export interface CursorEffortVariant {
  /** Effort token: none | minimal | low | medium | high | xhigh | max. */
  id: string;
  /** The concrete CLI id for this level, e.g. `cursor-grok-4.6-xhigh`. */
  cliId: string;
  /** True for the canonical (unsuffixed-name) variant. */
  default?: boolean;
}

// Model ids are lowercase slugs: `auto`, `gpt-5.5`, `sonnet-4.5`, `gemini-3.1-pro`.
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is exactly what an ANSI escape sequence starts with — stripping it is the point.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const DEFAULT_MARK_RE = /\(\s*(?:(?:default|current|selected)\s*,?\s*)+\)|\*\s*$|^\*\s*/i;

function looksLikeId(token: string): boolean {
  return ID_RE.test(token) && token.length <= 64;
}

// Bare words Cursor uses as model ids without a digit or hyphen.
const BARE_IDS = new Set([
  "auto",
  "composer",
  "fusion",
  "grok",
  "codex",
  "sonnet",
  "opus",
  "haiku",
  "gemini",
]);

/** Text mode is stricter than JSON: a lowercase prose word must not become a model. */
function plausibleTextId(token: string): boolean {
  return looksLikeId(token) && (/[\d-]/.test(token) || BARE_IDS.has(token));
}

/** `gpt-5.5` → `GPT 5.5`, `composer-2.5` → `Composer 2.5`, `auto` → `Auto`. */
export function prettifyModelId(id: string): string {
  if (id === "auto") return "Auto";
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      if (/^(gpt|o\d)$/i.test(part)) return part.toUpperCase();
      if (/^\d/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function fromJsonValue(value: unknown): CursorModelEntry[] {
  const pick = (obj: Record<string, unknown>, keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  };
  let list: unknown[] | null = null;
  if (Array.isArray(value)) list = value;
  else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of ["models", "data", "items", "result"]) {
      if (Array.isArray(obj[k])) {
        list = obj[k] as unknown[];
        break;
      }
    }
  }
  if (!list) return [];
  const out: CursorModelEntry[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      if (looksLikeId(item)) out.push({ id: item, name: prettifyModelId(item) });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = pick(obj, ["id", "model", "slug", "value", "name"]);
    if (!id || !looksLikeId(id)) continue;
    const name = pick(obj, ["displayName", "display_name", "label", "title", "name"]);
    const isDefault = obj.default === true || obj.isDefault === true || obj.is_default === true;
    out.push({
      id,
      name: name && name !== id ? name : prettifyModelId(id),
      ...(isDefault ? { isDefault: true } : {}),
    });
  }
  return out;
}

function fromText(raw: string): CursorModelEntry[] {
  const out: CursorModelEntry[] = [];
  for (const rawLine of raw.replace(ANSI_RE, "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.endsWith(":")) continue; // blank / section header
    if (/[`<>]|--/.test(line)) continue; // usage hints / flag docs, not entries
    if (
      /^(usage|options?|commands?|available models|models)\b/i.test(line) &&
      !/[-–:]\s/.test(line)
    ) {
      continue;
    }
    const isDefault = DEFAULT_MARK_RE.test(line);
    line = line.replace(DEFAULT_MARK_RE, "").trim();
    line = line.replace(/^[-*•>]\s+/, ""); // bullets

    // "Name (id)" — id in trailing parens.
    const paren = /^(.*?)\s*\(([a-z0-9][a-z0-9._-]*)\)\s*$/.exec(line);
    if (paren && plausibleTextId(paren[2] as string)) {
      const id = paren[2] as string;
      const name = (paren[1] as string).trim() || prettifyModelId(id);
      out.push({ id, name, ...(isDefault ? { isDefault: true } : {}) });
      continue;
    }

    // "id — Name", "id: Name", "id  Name", or bare "id".
    const m = /^([^\s:—–-]+(?:-[^\s:—–]+)*)\s*(?:[—–:-]\s*|\s{2,}|\s+)?(.*)$/.exec(line);
    if (!m) continue;
    const id = m[1] as string;
    if (!plausibleTextId(id)) continue;
    const rest = (m[2] as string).trim();
    out.push({ id, name: rest || prettifyModelId(id), ...(isDefault ? { isDefault: true } : {}) });
  }
  return out;
}

/**
 * Parse the raw stdout of `cursor-agent models` (JSON or text). Returns [] when
 * nothing recognizable is present so the caller can fall back.
 */
export function parseCursorModelList(raw: string): CursorModelEntry[] {
  const trimmed = raw.replace(ANSI_RE, "").trim();
  if (!trimmed) return [];
  let entries: CursorModelEntry[] = [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      entries = fromJsonValue(JSON.parse(trimmed));
    } catch {
      entries = [];
    }
  }
  if (!entries.length) entries = fromText(trimmed);

  // Dedupe by id, first occurrence wins (keeps the CLI's ordering).
  const seen = new Set<string>();
  return entries.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Roster filtering. Cursor's listing multiplies every model by effort level
// (low/medium/high/xhigh/max/none/thinking) and a `-fast` variant — 200+ rows.
// The picker shows ONE entry per chosen family: the latest version, in its
// canonical variant (the one whose display name carries no effort words, e.g.
// `cursor-grok-4.6-high` → "Cursor Grok 4.6").

/** Families shown in the picker, in display order. Edit to taste. */
export const CURSOR_FAMILIES = ["grok", "composer", "kimi"] as const;

const EFFORT_TOKENS = new Set([
  "fast",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "none",
  "minimal",
  "thinking",
]);
/** Ordered effort LEVELS (a subset of EFFORT_TOKENS — `fast`/`thinking` are mode flags). */
const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const MODE_FLAGS = new Set(["fast", "thinking"]);
/** Display order for mode toggles. */
const MODE_ORDER = ["fast", "thinking"];

/** Split an id into its base, effort level (if any) and mode flags. */
export function splitVariant(id: string): { base: string; level: string | null; flags: string[] } {
  const toks = tokensOf(id);
  const suffix: string[] = [];
  while (toks.length > 1 && EFFORT_TOKENS.has(toks[toks.length - 1] as string))
    suffix.unshift(toks.pop() as string);
  const level = suffix.find((t) => EFFORT_LEVELS.includes(t)) ?? null;
  const flags = suffix.filter((t) => MODE_FLAGS.has(t)).sort();
  return { base: toks.join("-"), level, flags };
}
const EFFORT_WORDS_RE = /\b(fast|low|medium|high|extra high|xhigh|max|none|minimal|thinking)\b/gi;

const tokensOf = (id: string) => id.split(/[-_]/).filter(Boolean);

/** Which configured family an id belongs to (by token match), or null. */
export function familyOf(id: string, families: readonly string[] = CURSOR_FAMILIES): string | null {
  const toks = tokensOf(id);
  return families.find((f) => toks.includes(f)) ?? null;
}

/** `cursor-grok-4.6-xhigh-fast` → `cursor-grok-4.6`; `kimi-k2.7-code` stays. */
export function baseModelId(id: string): string {
  const toks = tokensOf(id);
  while (toks.length > 1 && EFFORT_TOKENS.has(toks[toks.length - 1] as string)) toks.pop();
  return toks.join("-");
}

/** Version segments after the family token: `kimi-k2.7-code` → [2, 7]; none → []. */
function versionOf(base: string, family: string): number[] {
  const toks = tokensOf(base);
  const after = toks.slice(toks.indexOf(family) + 1);
  const vt = after.find((t) => /\d/.test(t));
  if (!vt) return [];
  return vt
    .replace(/^[a-z]+/i, "")
    .split(".")
    .map((n) => Number(n) || 0);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** How many effort/speed words the display name carries — 0 is the canonical variant. */
function effortWordCount(name: string): number {
  return (name.match(EFFORT_WORDS_RE) ?? []).length;
}

/**
 * Reduce a full roster to one entry per family in CURSOR_FAMILIES order (plus
 * `auto`, kept first when present): latest version, canonical variant.
 */
export function pickLatestPerFamily(
  entries: CursorModelEntry[],
  families: readonly string[] = CURSOR_FAMILIES,
): CursorModelEntry[] {
  const out: CursorModelEntry[] = entries.filter((e) => e.id === "auto").slice(0, 1);
  for (const family of families) {
    const members = entries.filter((e) => e.id !== "auto" && familyOf(e.id, families) === family);
    if (!members.length) continue;
    // Latest base version wins.
    let bestBase: string | null = null;
    let bestVersion: number[] = [];
    for (const m of members) {
      const base = baseModelId(m.id);
      const v = versionOf(base, family);
      if (bestBase === null || compareVersions(v, bestVersion) > 0) {
        bestBase = base;
        bestVersion = v;
      }
    }
    // Canonical variant of that base: fewest effort words in the name, then the
    // non-`fast` id, then the shortest id.
    const siblings = members
      .filter((m) => baseModelId(m.id) === bestBase)
      .sort(
        (a, b) =>
          effortWordCount(a.name) - effortWordCount(b.name) ||
          Number(a.id.endsWith("-fast")) - Number(b.id.endsWith("-fast")) ||
          a.id.length - b.id.length,
      );
    const canonical = siblings[0] as CursorModelEntry;
    const canon = splitVariant(canonical.id);
    // Only siblings that KEEP the canonical mode flags: a non-thinking sibling of a
    // thinking canonical is a different offering, not a mode of this one.
    const rows = siblings
      .map((v) => ({ v, parts: splitVariant(v.id) }))
      .filter(({ parts }) => canon.flags.every((f) => parts.flags.includes(f)));

    // The (effort, modes) → CLI id matrix, plus the extra flags that appear in it.
    const variants: Record<string, string> = {};
    const extras = new Set<string>();
    for (const { v, parts } of rows) {
      const extra = parts.flags.filter((f) => !canon.flags.includes(f));
      for (const f of extra) extras.add(f);
      variants[variantKey(parts.level, extra)] = v.id;
    }
    // Effort levels = rows in the canonical mode (no extra flags).
    const levels = rows
      .filter(({ parts }) => parts.level && parts.flags.length === canon.flags.length)
      .sort(
        (a, b) =>
          EFFORT_LEVELS.indexOf(a.parts.level as string) -
          EFFORT_LEVELS.indexOf(b.parts.level as string),
      )
      .map(({ v, parts }) => ({
        id: parts.level as string,
        cliId: v.id,
        ...(v.id === canonical.id ? { default: true } : {}),
      }));
    const modes = [...extras].sort((a, b) => MODE_ORDER.indexOf(a) - MODE_ORDER.indexOf(b));
    out.push({
      ...canonical,
      ...(levels.length >= 2 ? { efforts: levels } : {}),
      ...(modes.length ? { modes } : {}),
      ...(levels.length >= 2 || modes.length ? { variants } : {}),
    } as CursorModelEntry);
  }
  return out;
}
