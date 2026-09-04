export type LogoTheme = "light" | "dark";
/**
 * Anything that can resolve to a brand logo: a bare author/provider name, or a
 * catalog model-shaped object. UI stores often shim `author`; the gateway
 * returns `model_author.name` / `owned_by` — accept all three so Meta (and
 * every other author) renders without a client-side rename.
 */
export type ProviderLogoInput = string | {
    author?: string | null;
    model_author?: {
        name?: string | null;
    } | null;
    owned_by?: string | null;
} | null | undefined;
/**
 * Returns a data-URI for the given provider/author's logo, or an empty string
 * when there is no brand mark (unknown / missing author).
 * Works in any environment (Node, browser, Electron, Tauri) with no bundler config.
 */
export declare function getProviderLogo(input: ProviderLogoInput, theme?: LogoTheme): string;
/** Author keys with a logo available (e.g. "anthropic", "openai"). */
export declare function listProviderLogos(): string[];
/** Minimal shape needed to resolve a catalog model's brand logo. */
export interface ModelLogoInput {
    model_author?: {
        name?: string | null;
    } | null;
    owned_by?: string | null;
}
/**
 * Resolve a catalog model's brand logo, preferring the friendly
 * `model_author.name` (present when models are listed with
 * `include: ["author"]`) and falling back to the `owned_by` slug. A
 * convenience over {@link getProviderLogo} that encodes the correct field to
 * key on — logos are indexed by author/provider name, not by model id.
 */
export declare function getModelLogo(model: ModelLogoInput, theme?: LogoTheme): string;
//# sourceMappingURL=logos.d.ts.map