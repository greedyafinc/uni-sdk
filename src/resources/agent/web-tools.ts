// Opt-in web tool pack for `sdk.agent` — search then fetch, no API key.
//
// Compose into `RunAgentOptions.tools` alongside `fsTools()`:
//   tools: [...fsTools(ns), ...webTools()]
//
// These run on the HOST (same as fs tools), not on the gateway. The default
// search backend scrapes DuckDuckGo HTML; inject `{ search }` for SearXNG.
// Browser pages cannot call DuckDuckGo directly (CORS) — this pack is for
// Node / node-service / CLI agents unless a gateway proxy is added later.
import { type FetchLike, duckDuckGoSearchBackend } from "./_internal/ddg-search";
import { extractHtmlMeta, formatFetchMeta } from "./_internal/html-meta";
import { htmlToText } from "./_internal/html-to-text";
import type { SearchBackend, SearchHit } from "./_internal/search-types";
import { assertSafeFetchUrl, isPrivateOrMetadataHost } from "./_internal/ssrf";
import type { ToolSpec } from "./types";

// Re-exported as `WebSearchHit`, not `SearchHit`: the top-level barrel also
// carries `SearchHit` from `resources/search/types` (the cross-app search
// contract), and the two names must not collide there.
export type { SearchBackend, SearchHit as WebSearchHit, SearchOptions } from "./_internal/search-types";
export type { FetchLike } from "./_internal/ddg-search";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_FETCH_CHARS = 64_000;
/** Soft cap on response body bytes before we stop reading. */
const DEFAULT_MAX_FETCH_BYTES = 512_000;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "No results.";
  return hits
    .map((h, i) => {
      const snip = h.snippet ? `\n   ${h.snippet}` : "";
      return `${i + 1}. ${h.title}\n   ${h.url}${snip}`;
    })
    .join("\n\n");
}

/**
 * Merge a caller AbortSignal with a timeout. Aborts the returned signal when
 * either fires. Caller should clear the timer when the work finishes.
 */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      ctrl.abort(signal.reason);
      return { signal: ctrl.signal, clear: () => {} };
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(
    () => ctrl.abort(new Error(`Timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  return {
    signal: ctrl.signal,
    clear: () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

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
export function webTools(options: WebToolsOptions = {}): ToolSpec[] {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const search = options.search ?? duckDuckGoSearchBackend(fetchImpl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFetchChars = options.maxFetchChars ?? DEFAULT_MAX_FETCH_CHARS;

  return [
    {
      definition: {
        type: "function",
        function: {
          name: "web_search",
          description:
            "Search the public web (DuckDuckGo). Returns numbered titles, URLs, and snippets. Use web_fetch on a promising URL to read the full page.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query." },
              maxResults: {
                type: "number",
                description: `Max results to return (default ${DEFAULT_MAX_RESULTS}, max 10).`,
              },
            },
            required: ["query"],
          },
        },
      },
      async execute(input, signal) {
        const query = String(input.query ?? "").trim();
        if (!query) return { content: "query is required", isError: true };
        let maxResults = DEFAULT_MAX_RESULTS;
        if (typeof input.maxResults === "number" && Number.isFinite(input.maxResults)) {
          maxResults = Math.min(10, Math.max(1, Math.floor(input.maxResults)));
        }
        const { signal: timed, clear } = withTimeout(signal, timeoutMs);
        try {
          const hits = await search.search(query, { maxResults, signal: timed });
          return { content: formatHits(hits) };
        } catch (e) {
          if (timed.aborted && !signal.aborted) {
            return { content: errText(e), isError: true };
          }
          return { content: errText(e), isError: true };
        } finally {
          clear();
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "web_fetch",
          description:
            "Fetch a public http(s) URL and return readable text (HTML stripped, truncated). Private/metadata hosts are blocked. Prefer URLs from web_search.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "Absolute http(s) URL to fetch." },
            },
            required: ["url"],
          },
        },
      },
      async execute(input, signal) {
        const raw = String(input.url ?? "").trim();
        const checked = assertSafeFetchUrl(raw);
        if (!checked.ok) return { content: checked.error, isError: true };

        const { signal: timed, clear } = withTimeout(signal, timeoutMs);
        try {
          // Manual redirect following so we can re-check the host after each hop.
          let current = checked.url;
          let res: Response | null = null;
          for (let hop = 0; hop < 5; hop++) {
            res = await fetchImpl(current.href, {
              method: "GET",
              redirect: "manual",
              signal: timed,
              headers: {
                "user-agent": "UnifiedAI-SDK/0.2 (agent web_fetch)",
                accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
              },
            });
            if (res.status >= 300 && res.status < 400) {
              const loc = res.headers.get("location");
              if (!loc) {
                return { content: `Redirect without Location (HTTP ${res.status})`, isError: true };
              }
              let next: URL;
              try {
                next = new URL(loc, current);
              } catch {
                return { content: `Invalid redirect Location: ${loc}`, isError: true };
              }
              const recheck = assertSafeFetchUrl(next.href);
              if (!recheck.ok) return { content: recheck.error, isError: true };
              // Defense in depth if hostname resolved oddly
              if (isPrivateOrMetadataHost(recheck.url.hostname)) {
                return {
                  content: `Blocked redirect host: ${recheck.url.hostname}`,
                  isError: true,
                };
              }
              current = recheck.url;
              continue;
            }
            break;
          }
          if (!res) return { content: "Fetch failed", isError: true };
          if (!res.ok) {
            return { content: `HTTP ${res.status} fetching ${current.href}`, isError: true };
          }

          // Re-check final URL in case the runtime resolved somehow differently.
          const finalCheck = assertSafeFetchUrl(current.href);
          if (!finalCheck.ok) return { content: finalCheck.error, isError: true };

          const buf = await readBodyCapped(res, DEFAULT_MAX_FETCH_BYTES, timed);
          const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
          const isHtml = ctype.includes("html") || /^\s*</.test(buf);
          const meta = isHtml ? extractHtmlMeta(buf, current.href) : {};
          let text: string;
          if (isHtml) {
            text = htmlToText(buf, maxFetchChars);
          } else {
            text =
              buf.length > maxFetchChars
                ? `${buf.slice(0, maxFetchChars)}\n\n[truncated at ${maxFetchChars} characters]`
                : buf;
          }
          if (!text.trim()) {
            const header = formatFetchMeta(current.href, meta);
            return { content: meta.title || meta.icon ? header : "(empty page)" };
          }
          return { content: `${formatFetchMeta(current.href, meta)}\n\n${text}` };
        } catch (e) {
          return { content: errText(e), isError: true };
        } finally {
          clear();
        }
      },
    },
  ];
}

/** Read response body as text, stopping after `maxBytes`. */
async function readBodyCapped(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!res.body || typeof res.body.getReader !== "function") {
    const t = await res.text();
    return t.length > maxBytes ? t.slice(0, maxBytes) : t;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (bytes >= maxBytes) {
        out += decoder.decode();
        await reader.cancel().catch(() => {});
        return out.slice(0, maxBytes);
      }
    }
    out += decoder.decode();
    return out;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
