import type { SearchBackend, SearchHit } from "./search-types.js";
/**
 * Parse DuckDuckGo HTML result page into hits.
 * Looks for `result__a` links and optional `result__snippet` siblings.
 */
export declare function parseDdgHtml(html: string, maxResults: number): SearchHit[];
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
/**
 * Default SearchBackend: DuckDuckGo HTML form POST.
 * Inject a different backend via `webTools({ search })` for SearXNG, etc.
 */
export declare function duckDuckGoSearchBackend(fetchImpl?: FetchLike): SearchBackend;
//# sourceMappingURL=ddg-search.d.ts.map