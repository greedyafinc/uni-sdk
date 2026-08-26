import type { Core } from "../core/core.js";
/** An action declaration. `id` is the actionId; the rest is the opaque, shell-owned spec. */
export interface ActionSpec {
    id: string;
    [key: string]: unknown;
}
export interface RegisteredAction {
    appId: string;
    actionId: string;
    spec: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
    /** On list: whether the app has a live pull channel. */
    live?: boolean;
}
export interface Invocation {
    id: string;
    appId: string;
    actionId: string;
    args: unknown;
    createdAt: number;
}
/** A developer-registered app (the platform-first identity root). */
export interface RegisteredApp {
    appId: string;
    display: Record<string, unknown>;
    declaredScopes: string[];
    reviewStatus: string;
    oauthClientId: string | null;
    createdAt: number;
    updatedAt: number;
}
export interface RegisterAppInput {
    /** Developer-chosen, unique. Cannot claim an app_id another developer owns. */
    appId: string;
    display?: Record<string, unknown>;
    declaredScopes?: string[];
    oauthClientId?: string | null;
}
export type InvokeResult = {
    id: string;
} | {
    status: "offline";
};
export type InvocationResult = {
    status: "pending";
} | {
    status: "done";
    result?: unknown;
    error?: {
        code: string;
        message: string;
    };
};
/** A handler for one action: receives the invocation args, returns a JSON result. */
export type ActionHandler = (args: unknown) => Promise<unknown> | unknown;
export declare class Actions {
    private readonly client;
    constructor(client: Core);
    /** Register (or update) an app you develop: metadata + declared scopes. */
    registerApp(input: RegisterAppInput): Promise<RegisteredApp>;
    /** List the apps you've registered. */
    listApps(): Promise<RegisteredApp[]>;
    /** Declare this app's ActionSpecs (idempotent upsert). */
    register(actions: ActionSpec[]): Promise<RegisteredAction[]>;
    /** List registered actions (optionally one app), each with liveness. */
    list(appId?: string): Promise<RegisteredAction[]>;
    /** Enqueue an invocation for a (possibly other) app. `offline` if it has no channel. */
    invoke(appId: string, actionId: string, args?: unknown): Promise<InvokeResult>;
    /** Poll a single invocation's result. */
    result(id: string): Promise<InvocationResult>;
    /** Poll until the invocation completes or the deadline passes. */
    awaitResult(id: string, options?: {
        timeoutMs?: number;
        intervalMs?: number;
    }): Promise<InvocationResult>;
    /** Register a push webhook (the server POSTs invocations to it), or clear it with "". */
    setWebhook(url: string): Promise<{
        ok: boolean;
    }>;
    /** Pull (and clear) this app's pending invocations. Also marks the app live. */
    pull(): Promise<Invocation[]>;
    /** Post an invocation's result or error. */
    respond(id: string, payload: {
        result?: unknown;
    } | {
        error: {
            code: string;
            message: string;
        };
    }): Promise<{
        ok: boolean;
    }>;
    /**
     * Serve registered actions: poll for work on an interval, dispatch to `handlers`, and
     * post each result. Returns a stop function. Unknown actions and handler throws are
     * reported back as errors so the invoker never hangs.
     */
    serve(handlers: Record<string, ActionHandler>, options?: {
        intervalMs?: number;
    }): () => void;
}
//# sourceMappingURL=actions.d.ts.map