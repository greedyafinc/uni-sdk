import { type CursorModelEntry, type EffortOption, type ModeOption, type VariantMap } from "./_internal/cursorModelList.js";
import { type LocalAgentSourcePref } from "./transport.js";
export declare const CLAUDE_CODE_MODEL_PREFIX = "claude-code/";
export declare const CURSOR_MODEL_PREFIX = "cursor/";
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
export declare function isLocalAgentModel(modelId: string | null | undefined): boolean;
/** Which lane runs `modelId`, or null when it is a gateway model. */
export declare function laneForModel(modelId: string): "claude-code" | "cursor" | null;
/** The alias `claude --model` wants; null means "omit the flag". */
export declare function claudeCodeCliModel(modelId: string): string | null;
/** Display name for an alias, for badges on models that left the catalog. */
export declare function claudeCodeModelName(alias: string): string;
/** The id `cursor-agent --model` wants, or null for `cursor/auto` (CLI default). */
export declare function cursorCliModel(modelId: string): string | null;
/**
 * The account's model list straight from `cursor-agent models` (cached per
 * source for the page session). Tries the format that worked last time first,
 * then the other.
 */
export declare function listCursorModels(pref?: LocalAgentSourcePref): Promise<CursorModelEntry[]>;
/** Drop every cached roster so the next catalog fetch re-queries the CLIs. */
export declare function invalidateCursorModels(): void;
/**
 * The `claude-code/*` and `cursor/*` catalog entries a source can actually run
 * — the ACTIVE one, or `pref`'s device when given (each device has its own
 * installed CLIs and its own Cursor roster). Empty when no desktop is
 * connected, or when neither CLI is installed on the machine behind it — the
 * picker never offers a provider that cannot run.
 *
 * Never throws: a detection or roster failure degrades to fewer entries.
 */
export declare function listLocalModels(pref?: LocalAgentSourcePref): Promise<LocalAgentModel[]>;
/**
 * A presentable stand-in for a local-agent id that isn't in the catalog (yet),
 * so a UI never flashes a raw id: `cursor/cursor-grok-4.6-high` → "Grok 4.6
 * High" by Cursor, `claude-code/opus` → "Claude Opus" by Claude Code. Returns
 * null for a gateway model.
 */
export declare function placeholderLocalModel(modelId: string): LocalAgentModel | null;
//# sourceMappingURL=catalog.d.ts.map