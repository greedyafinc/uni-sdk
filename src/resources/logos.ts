import { LOGO_DATA_URIS, type LogoSlug } from "./logos.generated";

export type LogoTheme = "light" | "dark";

export type ProviderLogoInput = string | { author?: string | null } | null | undefined;

const FALLBACK_SLUG: LogoSlug = "anything-llm-light";

const NORMALIZE_RE = /[\s.]+/g;

function normalizeKey(input: ProviderLogoInput): string | null {
  if (!input) return null;
  const raw = typeof input === "string" ? input : input.author;
  if (!raw) return null;
  return raw.toLowerCase().replace(NORMALIZE_RE, "");
}

function hasSlug(slug: string): slug is LogoSlug {
  return slug in LOGO_DATA_URIS;
}

function resolveSlug(input: ProviderLogoInput, theme: LogoTheme): LogoSlug {
  const key = normalizeKey(input);
  if (!key) return FALLBACK_SLUG;
  if (theme === "dark") {
    const dark = `${key}-dark`;
    if (hasSlug(dark)) return dark;
  }
  return hasSlug(key) ? key : FALLBACK_SLUG;
}

/**
 * Returns a data-URI for the given provider/author's logo.
 * Works in any environment (Node, browser, Electron, Tauri) with no bundler config.
 */
export function getProviderLogo(input: ProviderLogoInput, theme: LogoTheme = "light"): string {
  return LOGO_DATA_URIS[resolveSlug(input, theme)];
}

/** Author keys with a logo available (e.g. "anthropic", "openai"). */
export function listProviderLogos(): string[] {
  return Object.keys(LOGO_DATA_URIS).filter(
    (slug) => !slug.endsWith("-dark") && slug !== FALLBACK_SLUG,
  );
}

/** Minimal shape needed to resolve a catalog model's brand logo. */
export interface ModelLogoInput {
  model_author?: { name?: string | null } | null;
  owned_by?: string | null;
}

/**
 * Resolve a catalog model's brand logo, preferring the friendly
 * `model_author.name` (present when models are listed with
 * `include: ["author"]`) and falling back to the `owned_by` slug. A
 * convenience over {@link getProviderLogo} that encodes the correct field to
 * key on — logos are indexed by author/provider name, not by model id.
 */
export function getModelLogo(model: ModelLogoInput, theme: LogoTheme = "light"): string {
  const author = model.model_author?.name ?? model.owned_by ?? null;
  return getProviderLogo(author, theme);
}
