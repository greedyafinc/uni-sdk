// Shared types for pluggable web search backends (DDG today, SearXNG later).

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  maxResults?: number;
  signal?: AbortSignal;
}

/**
 * Pluggable search provider. Default is DuckDuckGo HTML; apps can inject
 * SearXNG or another free backend without changing the `web_search` tool schema.
 */
export interface SearchBackend {
  search(query: string, options: SearchOptions): Promise<SearchHit[]>;
}
