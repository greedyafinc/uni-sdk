// DuckDuckGo HTML search backend — no API key. Scrapes html.duckduckgo.com.
// Fragile by nature; isolated behind SearchBackend so apps can swap in SearXNG.

import type { SearchBackend, SearchHit, SearchOptions } from "./search-types";

const DDG_HTML = "https://html.duckduckgo.com/html/";

/** Decode common HTML entities in DDG result snippets/titles. */
function decodeBasicEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Strip tags from a snippet/title fragment. */
function stripTags(s: string): string {
  return decodeBasicEntities(s.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse DuckDuckGo HTML result page into hits.
 * Looks for `result__a` links and optional `result__snippet` siblings.
 */
export function parseDdgHtml(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  // Each organic result is typically a <div class="result ..."> block.
  // Match result links: <a class="result__a" href="...">title</a>
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null = linkRe.exec(html);
  while (match !== null && hits.length < maxResults) {
    let href = decodeBasicEntities(match[1] ?? "");
    const title = stripTags(match[2] ?? "");
    // DDG sometimes wraps redirects: //duckduckgo.com/l/?uddg=<encoded>&...
    try {
      const u = new URL(href, "https://html.duckduckgo.com");
      const uddg = u.searchParams.get("uddg");
      if (uddg) href = decodeURIComponent(uddg);
      else href = u.href;
    } catch {
      // keep raw href
    }
    if (!href || !title) {
      match = linkRe.exec(html);
      continue;
    }
    // Snippet: look ahead a short window for result__snippet
    const window = html.slice(match.index, match.index + 2500);
    const snipMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)/i.exec(
      window,
    );
    const snippet = snipMatch ? stripTags(snipMatch[1] ?? "") : "";
    hits.push({ title, url: href, snippet });
    match = linkRe.exec(html);
  }
  return hits;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Default SearchBackend: DuckDuckGo HTML form POST.
 * Inject a different backend via `webTools({ search })` for SearXNG, etc.
 */
export function duckDuckGoSearchBackend(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): SearchBackend {
  return {
    async search(query: string, options: SearchOptions): Promise<SearchHit[]> {
      const maxResults = options.maxResults ?? 5;
      const body = new URLSearchParams({ q: query });
      const init: RequestInit = {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          // DDG HTML endpoint is friendlier with a boring UA.
          "user-agent": "UnifiedAI-SDK/0.2 (agent web_search)",
        },
        body,
        redirect: "follow",
      };
      if (options.signal) init.signal = options.signal;
      const res = await fetchImpl(DDG_HTML, init);
      if (!res.ok) {
        throw new Error(`DuckDuckGo search failed: HTTP ${res.status}`);
      }
      const html = await res.text();
      return parseDdgHtml(html, maxResults);
    },
  };
}
