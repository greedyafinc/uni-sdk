// Synthetic model catalogs for the local agent CLIs.
//
// Neither Claude Code nor Cursor is a gateway provider: their models are served
// by the CLI installed on the DESKTOP, driven over the bridge or the relay. The
// entries below are shaped like the rows `sdk.models.list()` returns (and like
// the desktop's own `CatalogModel`), so a caller can simply concat them onto
// the gateway catalog. Ids stay EXACTLY `claude-code/*` and `cursor/*` on every
// source, so a conversation stays portable when the source changes.
//
// Ported from the desktop's `claudeCode/models.ts` + `cursor/models.ts`.
import {
  type CursorModelEntry,
  type EffortOption,
  type ModeOption,
  type VariantMap,
  effortLabel,
  modeHint,
  modeLabel,
  parseCursorModelList,
  pickLatestPerFamily,
  prettifyModelId,
} from "./_internal/cursorModelList";
import { type LocalAgentSourcePref, cursorModelsOutput, detectAgents } from "./transport";

export const CLAUDE_CODE_MODEL_PREFIX = "claude-code/";
export const CURSOR_MODEL_PREFIX = "cursor/";

/**
 * One local-agent catalog row. A superset of `HostModelEntry` / the gateway's
 * model rows in the fields a picker reads, plus the two local-only axes
 * (`efforts`, `modes`, `variants`) the desktop composer renders.
 */
export interface LocalAgentModel {
  id: string;
  "model-id": string;
  name: string;
  author: string;
  type?: string;
  owned_by?: string;
  context_size?: number | null;
  /** Reasoning levels this model offers (pick one). */
  efforts?: EffortOption[];
  /** Independent on/off flags (e.g. `fast`). */
  modes?: ModeOption[];
  /** (effort, modes) → concrete model id, for providers that vary by variant. */
  variants?: VariantMap;
}

/**
 * Whether `modelId` is served by a local agent CLI rather than the gateway.
 *
 * Prefix-based and synchronous on purpose: it is a CAPABILITY check callers make
 * before a run, and it must answer the same way whether or not a catalog has
 * been fetched. A local lane cannot honor `response_format`/`json_schema`,
 * `maxSteps` or `maxTokens`, and reports failures as an exit code + stderr
 * rather than the SDK's typed error hierarchy — so a call depending on any of
 * those must stay on the gateway regardless of the picker.
 */
export function isLocalAgentModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  return modelId.startsWith(CLAUDE_CODE_MODEL_PREFIX) || modelId.startsWith(CURSOR_MODEL_PREFIX);
}

/** Which lane runs `modelId`, or null when it is a gateway model. */
export function laneForModel(modelId: string): "claude-code" | "cursor" | null {
  if (modelId.startsWith(CLAUDE_CODE_MODEL_PREFIX)) return "claude-code";
  if (modelId.startsWith(CURSOR_MODEL_PREFIX)) return "cursor";
  return null;
}

// ── Claude Code ─────────────────────────────────────────────────────────────

/** Retired picker entry; still present in conversations saved before its removal. */
const LEGACY_AUTO_ALIAS = "auto";

/** The alias `claude --model` wants; null means "omit the flag". */
export function claudeCodeCliModel(modelId: string): string | null {
  const alias = modelId.slice(CLAUDE_CODE_MODEL_PREFIX.length);
  return alias === LEGACY_AUTO_ALIAS ? null : alias;
}

/**
 * `--effort` levels. Every turn passes one explicitly — there is deliberately no
 * "leave it to the CLI" entry, so the level a caller picked is the level that ran.
 */
const DEFAULT_EFFORT_ID = "medium";

const CLAUDE_EFFORTS: EffortOption[] = ["low", "medium", "high", "xhigh", "max"].map((id) => ({
  id,
  label: effortLabel(id),
  ...(id === DEFAULT_EFFORT_ID ? { default: true } : {}),
}));

interface ClaudeCodeModelEntry {
  alias: string;
  name: string;
  /** Whether `--effort` applies to this family. */
  effort?: boolean;
}

/**
 * Picker entries, in display order. The `claude` CLI has no roster command —
 * `--model` takes an alias for the latest model in a family — so this is a
 * static alias list rather than a parsed listing: aliases don't go stale the way
 * pinned ids do, and an unknown one is the user's own CLI telling them so.
 */
const CLAUDE_MODELS: ClaudeCodeModelEntry[] = [
  { alias: "opus", name: "Claude Opus", effort: true },
  { alias: "sonnet", name: "Claude Sonnet", effort: true },
  { alias: "haiku", name: "Claude Haiku" },
  { alias: "fable", name: "Claude Fable", effort: true },
];

/** Display name for an alias, for badges on models that left the catalog. */
export function claudeCodeModelName(alias: string): string {
  if (alias === LEGACY_AUTO_ALIAS) return "Claude Code";
  return CLAUDE_MODELS.find((m) => m.alias === alias)?.name ?? `Claude ${alias}`;
}

// What Claude Code itself assumes for an unrecognized model; only gates
// client-side history folding, since the CLI manages its own context window.
const CLAUDE_CODE_CONTEXT_SIZE = 200_000;
// Cursor manages its context server-side; same caveat.
const CURSOR_CONTEXT_SIZE = 200_000;

function claudeCodeModels(): LocalAgentModel[] {
  return CLAUDE_MODELS.map((m) => ({
    id: `${CLAUDE_CODE_MODEL_PREFIX}${m.alias}`,
    "model-id": `${CLAUDE_CODE_MODEL_PREFIX}${m.alias}`,
    name: m.name,
    // `author` is the picker's group label AND what the SDK keys the brand logo
    // off (SLUG_ALIASES in resources/logos.ts maps both "Claude Code" and
    // "claude-code" onto claude.svg) — renaming either drops the neutral mark.
    author: "Claude Code",
    type: "text",
    owned_by: "claude-code",
    context_size: CLAUDE_CODE_CONTEXT_SIZE,
    // No `variants`: effort is a request-time flag here, not a sibling model.
    ...(m.effort ? { efforts: CLAUDE_EFFORTS } : {}),
  }));
}

// ── Cursor ──────────────────────────────────────────────────────────────────

/** The id `cursor-agent --model` wants, or null for `cursor/auto` (CLI default). */
export function cursorCliModel(modelId: string): string | null {
  const cli = modelId.slice(CURSOR_MODEL_PREFIX.length);
  return cli === "auto" ? null : cli;
}

// Last-resort fallback when the CLI's own listing is unavailable (not logged
// in, unparseable output, timeout): `auto` is the CLI default and always valid.
const FALLBACK_CURSOR_MODELS: CursorModelEntry[] = [{ id: "auto", name: "Cursor Agent" }];

/**
 * Which output format this CLI answered `models` in last time. Each attempt
 * SPAWNS the CLI, and the losing one is pure latency; remembering the winner
 * makes a cold start one launch instead of two. Only ever an ordering hint.
 */
const FORMAT_KEY = "unified.cursor.modelsFormat";

function preferredFormat(): boolean | null {
  try {
    const raw = globalThis.localStorage?.getItem(FORMAT_KEY) ?? null;
    return raw === "json" ? true : raw === "plain" ? false : null;
  } catch {
    return null;
  }
}

function rememberFormat(json: boolean) {
  try {
    globalThis.localStorage?.setItem(FORMAT_KEY, json ? "json" : "plain");
  } catch {
    // fail-soft: worst case the next cold start tries both again
  }
}

/**
 * Rosters are cached PER SOURCE: `cursor-agent models` answers for the account
 * signed in on THAT machine, so a single global promise would leak one device's
 * roster into another device's catalog.
 */
const modelListPromises = new Map<string, Promise<CursorModelEntry[]>>();

function prefKey(pref?: LocalAgentSourcePref): string {
  if (!pref) return "auto";
  return pref.kind === "relay" ? `relay:${pref.deviceId}` : pref.kind;
}

/**
 * The account's model list straight from `cursor-agent models` (cached per
 * source for the page session). Tries the format that worked last time first,
 * then the other.
 */
export function listCursorModels(pref?: LocalAgentSourcePref): Promise<CursorModelEntry[]> {
  const key = prefKey(pref);
  let promise = modelListPromises.get(key);
  if (!promise) {
    promise = (async () => {
      const first = preferredFormat() ?? true;
      for (const json of [first, !first]) {
        try {
          const out = await cursorModelsOutput(json, pref);
          if (!out.ok) continue; // flag rejected / login required — try next
          const entries = parseCursorModelList(out.output);
          if (entries.length) {
            rememberFormat(json);
            return entries;
          }
        } catch {
          // try the other format
        }
      }
      return FALLBACK_CURSOR_MODELS;
    })();
    modelListPromises.set(key, promise);
  }
  return promise;
}

/** Drop every cached roster so the next catalog fetch re-queries the CLIs. */
export function invalidateCursorModels(): void {
  modelListPromises.clear();
}

async function cursorModels(pref?: LocalAgentSourcePref): Promise<LocalAgentModel[]> {
  // The raw roster is 200+ rows (every effort level × fast). Show `auto` plus
  // one canonical, latest entry per family.
  const ordered = pickLatestPerFamily(await listCursorModels(pref));
  return ordered.map((m) => ({
    id: `${CURSOR_MODEL_PREFIX}${m.id}`,
    "model-id": `${CURSOR_MODEL_PREFIX}${m.id}`,
    name: m.id === "auto" ? "Cursor Agent" : m.name,
    author: "Cursor",
    type: "text",
    owned_by: "cursor",
    context_size: CURSOR_CONTEXT_SIZE,
    // Effort levels and modes are sibling CLI ids: a selection swaps the model
    // sent, resolved through the `variants` matrix.
    ...(m.efforts
      ? {
          efforts: m.efforts.map((e) => ({
            id: e.id,
            label: effortLabel(e.id),
            modelId: `${CURSOR_MODEL_PREFIX}${e.cliId}`,
            ...(e.default ? { default: true } : {}),
          })),
        }
      : {}),
    ...(m.modes
      ? {
          modes: m.modes.map((id) => {
            const hint = modeHint(id);
            return { id, label: modeLabel(id), ...(hint ? { hint } : {}) };
          }),
        }
      : {}),
    ...(m.variants
      ? {
          variants: Object.fromEntries(
            Object.entries(m.variants).map(([k, cliId]) => [k, `${CURSOR_MODEL_PREFIX}${cliId}`]),
          ),
        }
      : {}),
  }));
}

// ── Merged listing ──────────────────────────────────────────────────────────

/**
 * The `claude-code/*` and `cursor/*` catalog entries a source can actually run
 * — the ACTIVE one, or `pref`'s device when given (each device has its own
 * installed CLIs and its own Cursor roster). Empty when no desktop is
 * connected, or when neither CLI is installed on the machine behind it — the
 * picker never offers a provider that cannot run.
 *
 * Never throws: a detection or roster failure degrades to fewer entries.
 */
export async function listLocalModels(pref?: LocalAgentSourcePref): Promise<LocalAgentModel[]> {
  let detected: Awaited<ReturnType<typeof detectAgents>>;
  try {
    detected = await detectAgents(pref);
  } catch {
    return [];
  }
  const out: LocalAgentModel[] = [];
  if (detected.claudeCode.found) out.push(...claudeCodeModels());
  if (detected.cursor.found) {
    try {
      out.push(...(await cursorModels(pref)));
    } catch {
      // roster unavailable — Claude Code entries still stand
    }
  }
  return out;
}

/**
 * A presentable stand-in for a local-agent id that isn't in the catalog (yet),
 * so a UI never flashes a raw id: `cursor/cursor-grok-4.6-high` → "Grok 4.6
 * High" by Cursor, `claude-code/opus` → "Claude Opus" by Claude Code. Returns
 * null for a gateway model.
 */
export function placeholderLocalModel(modelId: string): LocalAgentModel | null {
  if (modelId.startsWith(CLAUDE_CODE_MODEL_PREFIX)) {
    return {
      id: modelId,
      "model-id": modelId,
      name: claudeCodeModelName(modelId.slice(CLAUDE_CODE_MODEL_PREFIX.length)),
      author: "Claude Code",
      owned_by: "claude-code",
    };
  }
  if (modelId.startsWith(CURSOR_MODEL_PREFIX)) {
    const cli = modelId.slice(CURSOR_MODEL_PREFIX.length);
    return {
      id: modelId,
      "model-id": modelId,
      name: cli === "auto" ? "Cursor Agent" : prettifyModelId(cli.replace(/^cursor-/, "")),
      author: "Cursor",
      owned_by: "cursor",
    };
  }
  return null;
}
