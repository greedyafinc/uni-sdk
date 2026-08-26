import { type FetchLike } from "./_internal/ddg-search.js";
import type { SearchBackend } from "./_internal/search-types.js";
import type { ToolSpec } from "./types.js";
export type { SearchBackend, SearchHit as WebSearchHit, SearchOptions, } from "./_internal/search-types.js";
export type { FetchLike } from "./_internal/ddg-search.js";
export interface WebToolsOptions {
    /** Override the search provider (default: DuckDuckGo HTML). */
    search?: SearchBackend;
    /** Injectable fetch (tests). Defaults to `globalThis.fetch`. */
    fetch?: FetchLike;
    /** Per-request timeout in ms (default 10_000). */
    timeoutMs?: number;
    /** Max characters returned by `web_fetch` after HTML→text (default 64_000). */
    maxFetchChars?: number;
}
/**
 * Build `web_search` + `web_fetch` tools. Opt-in — not baked into `agent.run()`.
 *
 * Intended for Node / CLI / node-service hosts. Browser pages hit CORS on
 * DuckDuckGo; use a gateway proxy or a custom `search` backend if you need
 * search inside a browser-held agent.
 */
export declare function webTools(options?: WebToolsOptions): ToolSpec[];
//# sourceMappingURL=web-tools.d.ts.map