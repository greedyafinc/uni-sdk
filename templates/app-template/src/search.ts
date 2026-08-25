// Search entry (lib mode → search.js, the manifest's `search.entry`). The host
// imports this chunk lazily — WITHOUT app.js — so it must not reach into Vue
// or the component tree; only the store and the dependency-free kernel from
// @unifiedai/sdk/app.
import type { CreateSearchProvider, SearchHit, SearchRequest } from "@unifiedai/sdk/app";
import {
  HINTS_FLOOR,
  HOST_LIMITS,
  compareHits,
  isHinted,
  scoreFields,
  toSearchHit,
} from "@unifiedai/sdk/app";
import { listItems, type Item } from "./store";

const KIND = "item";

/** The host instantiates this with `{ sdk, appId, limits?, protocolVersion? }`
    and calls `search()` when fanning a query out across installed apps. */
export const createSearchProvider: CreateSearchProvider = ({ appId, limits }) => ({
  kinds: [KIND],
  async search(req: SearchRequest): Promise<SearchHit[]> {
    // The host skips providers whose kinds are excluded, but stay defensive.
    if (req.kinds && req.kinds.length > 0 && !req.kinds.includes(KIND)) return [];
    if (req.signal?.aborted) return [];

    // Documented protocol caps, overridden by any live values the host pushed.
    const caps = { ...HOST_LIMITS, ...limits };
    const limit = Math.min(req.limit, caps.PER_PROVIDER_REQUEST_LIMIT);

    const items = listItems(); // newest-updated first
    const candidates: { item: Item; score: number }[] = [];

    if (req.query === "") {
      // Empty query is recency mode: the most recently updated items, with a
      // descending score so the list arrives in rank order.
      items.slice(0, limit).forEach((item, i) => {
        candidates.push({ item, score: items.length - i });
      });
    } else {
      for (const item of items) {
        if (req.signal?.aborted) return [];
        const score = scoreFields(
          { title: item.title, secondary: item.preview, body: item.searchText },
          req.terms,
          req.query,
        );
        if (score > 0) {
          candidates.push({ item, score });
        } else if (isHinted(item.id, req.hints?.ids, appId)) {
          // Hinted-only items always surface, always last: HINTS_FLOOR sits
          // strictly below the weakest real match and strictly above 0.
          candidates.push({ item, score: HINTS_FLOOR });
        }
      }
      // Rank order is the contract: score desc, then recency as the tie-break.
      candidates.sort(compareHits((c) => c.item.updatedAt));
    }

    return candidates.slice(0, limit).map(({ item, score }) =>
      toSearchHit({
        id: item.id,
        kind: KIND,
        title: item.title,
        score,
        updatedAt: item.updatedAt,
        text: item.preview,
        textPreview: true,
        // No `action` override: the host opens hits through the app's standard
        // `openArtifact` verb (see src/entry.ts).
        openRef: { objectId: item.id, collection: "items" },
      }),
    );
  },
});
