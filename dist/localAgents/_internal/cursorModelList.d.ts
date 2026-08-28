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
export declare function variantKey(effortId: string | null | undefined, modeIds: string[]): string;
/** Canonical ordering + labels for the common level vocabulary. */
export declare const EFFORT_LEVEL_LABELS: ReadonlyArray<{
    id: string;
    label: string;
}>;
export declare function effortLabel(id: string): string;
export declare function modeLabel(id: string): string;
export declare function modeHint(id: string): string | undefined;
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
/** `gpt-5.5` → `GPT 5.5`, `composer-2.5` → `Composer 2.5`, `auto` → `Auto`. */
export declare function prettifyModelId(id: string): string;
/**
 * Parse the raw stdout of `cursor-agent models` (JSON or text). Returns [] when
 * nothing recognizable is present so the caller can fall back.
 */
export declare function parseCursorModelList(raw: string): CursorModelEntry[];
/** Families shown in the picker, in display order. Edit to taste. */
export declare const CURSOR_FAMILIES: readonly ["grok", "composer", "kimi"];
/** Split an id into its base, effort level (if any) and mode flags. */
export declare function splitVariant(id: string): {
    base: string;
    level: string | null;
    flags: string[];
};
/** Which configured family an id belongs to (by token match), or null. */
export declare function familyOf(id: string, families?: readonly string[]): string | null;
/** `cursor-grok-4.6-xhigh-fast` → `cursor-grok-4.6`; `kimi-k2.7-code` stays. */
export declare function baseModelId(id: string): string;
/**
 * Reduce a full roster to one entry per family in CURSOR_FAMILIES order (plus
 * `auto`, kept first when present): latest version, canonical variant.
 */
export declare function pickLatestPerFamily(entries: CursorModelEntry[], families?: readonly string[]): CursorModelEntry[];
//# sourceMappingURL=cursorModelList.d.ts.map