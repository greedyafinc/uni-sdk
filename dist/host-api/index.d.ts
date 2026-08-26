import type { UnifiedAI } from "../core/client.js";
import type { RunAgentOptions, RunAgentResult, ToolSpec } from "../resources/agent/types.js";
import type { FsNamespace } from "../resources/fs/types.js";
import type { ArtifactRef, OpenArtifactOutcome } from "../resources/openArtifact.js";
/** One catalog row of `HostSdk.models.list`. Only the fields the embedded
    editors read are typed; `type` gates which models are offered for text
    interactions, `model_author` groups the picker. */
export interface HostSdkModel {
    id: string;
    name: string;
    type: "text" | "image" | "video" | "audio" | "embedding";
    owned_by?: string;
    logo?: string | null;
    model_author?: {
        name: string;
        color?: string | null;
    };
    is_custom?: boolean;
}
export interface HostSdkChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
export interface HostSdkChatParams {
    model: string;
    messages: HostSdkChatMessage[];
    max_tokens?: number;
    temperature?: number;
    stop?: string | string[];
}
export interface HostSdkChatChoice {
    message: {
        content: string | null;
    };
    /** "stop" | "length" | … — "length" means the output was truncated. */
    finish_reason?: string | null;
}
/**
 * LEGACY structural slice of the host's SDK instance — the shape this module
 * typed `getSdk()` as before it was widened to the real `UnifiedAI` class
 * (which the host has always actually returned). Kept exported for apps that
 * still reference it; new code should use `UnifiedAI` directly.
 */
export interface HostSdk {
    models: {
        /** The model catalog, as returned by unified-api (`{ object, data }`). */
        list: (options?: {
            signal?: AbortSignal;
            include?: Array<"author">;
        }) => Promise<{
            object?: "list";
            data: HostSdkModel[];
        }>;
    };
    chat: {
        completions: {
            create: (params: HostSdkChatParams, options?: {
                signal?: AbortSignal;
            }) => Promise<{
                choices: HostSdkChatChoice[];
            }>;
        };
    };
}
/** Runtime context the host binds for each action invocation. */
export interface ActionContext {
    /** Active project id, bound from the host (not from caller params). */
    projectId: string | null;
    /** Aborted when the caller cancels or the deadline passes. */
    signal: AbortSignal;
    /** Streaming actions emit progress here. */
    progress: (data: unknown) => void;
    /** Who is driving the action. */
    caller: {
        kind: "host" | "app" | "mcp-external";
        tier: "first-party" | "untrusted";
    };
}
/**
 * An action handler. Return a plain JSON-serializable value; the host adapts it
 * per caller. May be an async generator (yield progress, return the result).
 */
export type ActionHandler<P = Record<string, unknown>, R = unknown> = (params: P, ctx: ActionContext) => Promise<R> | AsyncGenerator<unknown, R>;
/** One row of `listModels` — the host's merged catalog of gateway models plus
    whichever local agent CLIs are actually installed. */
export interface HostModelEntry {
    id: string;
    "model-id": string;
    name: string;
    author: string;
    type?: string;
    owned_by?: string;
    logo?: string | null;
    model_author?: {
        name?: string;
        color?: string | null;
    };
    context_size?: number | null;
}
/** The project the user is currently working in (host `stores/projects.ts`). */
export interface ProjectContext {
    id: string;
    name: string;
}
/**
 * The host's authoritative usage summary — the same numbers the profile card
 * shows (host `stores/auth.ts` `UsageSummary`). Every field is optional: the
 * host derives what it can from unified-api's usage response.
 */
export interface HostUsageSummary {
    plan?: string;
    totalCost?: number;
    limit?: number;
    percentUsed?: number;
    windowStart?: string;
    windowEnd?: string;
    credits?: number | null;
}
/**
 * Everything `@unified/host-api` exports, as one interface — useful for typing
 * a dev shim or a host bridge implementation as a whole. The per-function
 * documentation lives on ./ambient.d.ts (the copy consumers actually see).
 */
export interface HostApi {
    /**
     * The host's authenticated SDK instance — a full `UnifiedAI`, attributed to
     * this app by the host (each remote gets its own scoped instance).
     */
    getSdk(): UnifiedAI;
    /**
     * Build the agent loop's file tools (write/read/edit/list) bound to an
     * `sdk.fs` namespace — the SDK's canonical tool spec, reached through the
     * host so the app never bundles its own SDK copy.
     */
    fsTools(ns: FsNamespace): ToolSpec[];
    /**
     * A self-contained data-URI for a provider/author's brand logo. `input` is
     * the author/provider name (or a `{ author }` object); `theme` is POSITIONAL
     * (not an options object) — the host forwards it straight to the SDK, whose
     * dark variants need `"dark"` as the 2nd arg. Unknown names resolve to a
     * generic fallback logo (compare against `getProviderLogo("")` to detect it).
     */
    getProviderLogo(input: string | {
        author?: string | null;
    } | null | undefined, theme?: "light" | "dark"): string;
    /**
     * The host's resolved color scheme ("light" | "dark"). The host collapses
     * the user's light/dark/system preference; the app's chrome also follows it
     * via CSS keyed off `[data-theme="dark"]` on the shared <html>.
     */
    getTheme(): "light" | "dark";
    /**
     * Subscribe to host color-scheme changes. Fires once immediately, then on
     * every change. Returns an unsubscribe function.
     */
    onThemeChange(cb: (theme: "light" | "dark") => void): () => void;
    /**
     * Register this app's action handlers with the host — the reverse of the
     * getters above (the host invokes INTO the app through these). The app
     * supplies no id: the host attributes it from the app being loaded. Register
     * at module scope so handlers stay live for the session. Returns an
     * unregister function.
     */
    registerActions(handlers: Record<string, ActionHandler>): () => void;
    /**
     * Run one agent turn through the host, which picks the lane from the model:
     * gateway models go through the SDK's agent loop, while models served by a
     * locally installed agent CLI (Cursor, Claude Code) go through the host's
     * child-process bridge. `sessionKey` keeps a conversation's CLI thread
     * context across turns; omit it for fan-out workers. Throws when the host is
     * too old to provide the bridge — feature-detect with `hasRunAgent()`.
     */
    runAgent(options: RunAgentOptions & {
        sessionKey?: string;
    }): Promise<RunAgentResult>;
    /** Whether the host provides the agent-run bridge (false standalone / old host). */
    hasRunAgent(): boolean;
    /**
     * The host's merged model catalog: gateway models plus whichever local agent
     * CLIs are actually installed. Prefer this over `getSdk().models.list()`,
     * which only ever sees the gateway half. Null when the host is too old.
     */
    listModels(): Promise<HostModelEntry[] | null>;
    /**
     * Whether a model is served by a local agent CLI rather than the gateway.
     * Local lanes cannot honor `response_format`/`json_schema`, `maxSteps` or
     * `maxTokens`, and report failures without the SDK's typed `errorCode` — so
     * any call depending on those must stay on the gateway even when the user
     * has picked a local model. False when the host is too old.
     */
    isLocalAgentModel(modelId: string | null | undefined): boolean;
    /**
     * The host's authoritative usage summary (same source as the profile card).
     * Resolves to null when the host is too old to provide it, so callers can
     * fall back to `getSdk().usage`.
     */
    getUsage(): Promise<HostUsageSummary | null>;
    /**
     * The project the user is currently working in (or null). Apps file new work
     * into it and scope their @-mention picker to it; cross-app content is read
     * back via `sdk.references`. Null when standalone or the host is too old.
     */
    getCurrentProject(): ProjectContext | null;
    /**
     * Subscribe to current-project changes. Fires once immediately with the
     * current context, then on every change. Returns an unsubscribe function
     * (a no-op when the host is too old to provide it).
     */
    onProjectChange(cb: (project: ProjectContext | null) => void): () => void;
    /**
     * Put one artifact on screen, in whatever app owns it — the single cross-app
     * open path (@-mention chips, reference cards, project links). Build the ref
     * with `artifactRefFromLink` from @unifiedai/sdk when you hold a ProjectLink.
     *
     * Resolves to null when there is no host bridge (standalone dev), so an app
     * can tell "the shell handled this" from "there is no shell" and fall back
     * to its own UI. Otherwise the outcome says what was actually achieved: only
     * `kind: "item"` means the artifact is on screen — `"app"` and
     * `"unavailable"` both carry a `reason` fit to show the user. Never report
     * those as success.
     */
    openArtifact(ref: ArtifactRef): Promise<OpenArtifactOutcome | null>;
}
export type { RunAgentOptions, RunAgentResult, ToolSpec, FsNamespace, ArtifactRef, OpenArtifactOutcome, UnifiedAI, };
//# sourceMappingURL=index.d.ts.map