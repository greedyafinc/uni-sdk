/**
 * Escape `s` so it can be interpolated into app-authored markup — in a text
 * node OR inside a single- or double-quoted attribute — without injecting
 * markup.
 *
 * All five of the entities the HTML spec asks for: `&`, `<`, `>`, `"`, `'`.
 * `&` MUST be replaced first or the later replacements' own ampersands get
 * double-escaped.
 *
 * This is intentionally the *widest* contract rather than the narrowest that
 * works at any one call site. In a text node the extra `&quot;`/`&#39;` are
 * decoded straight back to `"`/`'` by the parser, so the rendered result is
 * identical to what a 3-entity escape produced; in an attribute the narrower
 * escapes were a latent hole. One helper, safe in both positions.
 *
 * NOT a sanitizer: it escapes a *value*, it does not clean untrusted HTML.
 * Anything that must survive as markup goes through DOMPurify instead.
 */
export declare function escapeHtml(s: string): string;
/**
 * Cut `text` to at most `max` characters without splitting a word.
 *
 * The cap ALWAYS wins: when the first `max` characters hold no usable space
 * (a single oversized token, or — with `minKeepRatio` — only a space so early
 * that breaking there would throw most of the budget away) this falls back to
 * a hard cut at `max`. Either branch is right-trimmed, so the result never
 * ends in whitespace.
 *
 * `minKeepRatio` is the floor, as a fraction of `max`, that a candidate break
 * must reach to be preferred over the hard cut. It defaults to 0 — take any
 * word boundary, which is what the docs and sheets projections want, since
 * their input is already a dense word list. design's HTML projection passes
 * 0.6: its input can contain a single very long unbroken token (a data-URI
 * remnant, a minified class soup) followed by ordinary prose, and cutting back
 * to the last space before it would discard most of the searchable text.
 */
export declare function truncateOnWord(text: string, max: number, minKeepRatio?: number): string;
/**
 * Clamp `text` for a fixed-width card preview: at most `max` characters
 * INCLUDING the trailing ellipsis, cut on a character (not word) boundary
 * because a preview is glanced at, not read.
 *
 * Deliberately different from `truncateOnWord` — previews want the row to be
 * visibly full and to say "there is more", search projections want whole words
 * and no filler. Short input is returned untouched, with no ellipsis.
 */
export declare function clampWithEllipsis(text: string, max: number): string;
/** Characters of preview text stored on a listing row for the home card. */
export declare const PREVIEW_MAX = 160;
/**
 * HARD CAP on a record's inline `searchText` projection.
 *
 * There is currently NO server-side limit of any kind on inline metadata size
 * (unified-api `modules/storage` stores the row's metadata as-is) — this
 * constant is the ONLY bound on per-record growth, in every app. A document
 * with 200 pages of prose must not balloon its listing row, because every
 * listing row is fetched on every list() call, on every keystroke of search.
 *
 * Do not raise it without a server-side bound to match. It lives here so the
 * apps cannot drift to different values, which is precisely what happened to
 * `HINTS_FLOOR` before the shared search module collected it.
 */
export declare const SEARCH_TEXT_MAX = 1200;
//# sourceMappingURL=index.d.ts.map