import type { HostLimits } from "../../app/limits.js";
/** Hints the host derives from memory + recent conversation to help a provider pinpoint items. Always optional and best-effort. */
export interface SearchHints {
    /** Handles ("<appId>:<objectId>") the host believes the query refers to. */
    ids?: string[];
    /** Literal titles extracted from the query or from memory. */
    titles?: string[];
    /** Project the user is currently working in, if any. */
    projectId?: string | null;
    /** Recently opened/edited handles, most recent first. */
    recentIds?: string[];
    /** Only consider items updated at or after this epoch-ms timestamp. */
    since?: number;
}
/** One search request handed to a provider. */
export interface SearchRequest {
    /** Raw query. An empty string means "return the most recently updated items". */
    query: string;
    /** Host-tokenized, lowercased, deduped terms from `query`. Empty when `query` is empty. */
    terms: string[];
    /** Restrict to these provider-defined kinds. Undefined means all kinds. */
    kinds?: string[];
    /** Maximum hits the provider should return. */
    limit: number;
    /** Aborted when the host's per-provider budget expires. Providers must honor it. */
    signal: AbortSignal;
    hints?: SearchHints;
}
/** App-defined default visualization for an item, used by search results, mentions and chat reference chips. */
export interface SearchPreview {
    /** App-defined preview kind, e.g. "range" | "thumbnail" | "text". */
    kind: string;
    /** Small inline payload. Must be JSON-serializable and under ~2KB. */
    data?: unknown;
    /** Reference the owning app can resolve later (artifact id, blob key, …). */
    ref?: string;
}
/** How the host should open an item. Resolved through existing navigation; never a raw URL. */
export interface SearchOpenRef {
    objectId: string;
    collection?: string;
    projectId?: string | null;
    /** Must name a declared, non-mutating action of the SAME app. The host rejects anything else. */
    action?: string;
    params?: Record<string, unknown>;
}
/** One result. The host stamps the owning app id; providers must not supply it. */
export interface SearchHit {
    /** App-local object id. */
    id: string;
    /** App-defined lowercase kind, e.g. "sheet" | "doc" | "design" | "note" | "issue" | "event". */
    kind: string;
    title: string;
    /** Short plain-text excerpt. Treated as untrusted, artifact-authored content by the host. */
    snippet?: string;
    /** Provider-local relevance score, higher is better. The host normalizes by rank, not by value. */
    score: number;
    /** Epoch-ms last-updated timestamp; drives the host's recency boost. */
    updatedAt?: number;
    projectId?: string | null;
    /** Enclosing container's display name, e.g. workbook or folder. */
    containerTitle?: string;
    preview?: SearchPreview;
    openRef?: SearchOpenRef;
}
/** Implemented by each app. Never exposed to the model as a tool. */
export interface SearchProvider {
    /** Kinds this provider can return. Lets the host skip it when `kinds` excludes all of them. */
    kinds?: string[];
    search(req: SearchRequest): Promise<SearchHit[]> | SearchHit[];
}
/**
 * Context the host passes when instantiating a provider from an app's search
 * entry module. `sdk` is typed `unknown` rather than `UnifiedAI`: the
 * `UnifiedAI` class lives in `core/client.ts`, which imports every resource
 * module to assemble the facade — importing `UnifiedAI` back from here would
 * make this module part of that cycle. Consumers should cast to their own
 * `UnifiedAI` import (from `@unifiedai/sdk` or `@unifiedai/sdk/node`).
 */
export interface SearchProviderContext {
    /** The host's authenticated SDK instance. */
    sdk: unknown;
    /** Host-assigned app id. Never self-reported by the app. */
    appId: string;
    /**
     * The host's live caps, where they differ from the documented defaults —
     * runtime truth pushed by the host; the constants in @unifiedai/sdk/app
     * (`HOST_LIMITS`) are the documented defaults a provider assumes when this
     * is absent.
     */
    limits?: Partial<HostLimits>;
    /**
     * The search-protocol version the host speaks — runtime truth pushed by the
     * host; `SEARCH_PROTOCOL_VERSION` in @unifiedai/sdk/app is the documented
     * default when this is absent.
     */
    protocolVersion?: number;
}
/** An app's search entry module must default-export or named-export `createSearchProvider`. */
export type CreateSearchProvider = (ctx: SearchProviderContext) => SearchProvider | Promise<SearchProvider>;
//# sourceMappingURL=types.d.ts.map