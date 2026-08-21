// `sdk.actions` — participate in cross-app actions from a standalone app (PROTOCOL.md
// §Action registry). Declare ActionSpecs, then SERVE invocations over a pull channel:
// `serve(handlers)` polls for work, runs the handler, and posts the result — so a CLI
// behind NAT needs no reachable endpoint. The invoker side (`invoke` + `awaitResult`)
// mirrors it. App identity is server-derived from the credential.
import type { Core, RequestOptions } from "../core/core";
import { pollUntil } from "./_internal/poll";

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

export type InvokeResult = { id: string } | { status: "offline" };
export type InvocationResult =
  | { status: "pending" }
  | { status: "done"; result?: unknown; error?: { code: string; message: string } };

/** A handler for one action: receives the invocation args, returns a JSON result. */
export type ActionHandler = (args: unknown) => Promise<unknown> | unknown;

export class Actions {
  constructor(private readonly client: Core) {}

  // ── Developer app registration (§2a) ─────────────────────────────────────────

  /** Register (or update) an app you develop: metadata + declared scopes. */
  registerApp(input: RegisterAppInput): Promise<RegisteredApp> {
    return this.client.request<RegisteredApp>("/api/v1/registry/apps", {
      method: "POST",
      body: input,
    });
  }

  /** List the apps you've registered. */
  async listApps(): Promise<RegisteredApp[]> {
    const res = await this.client.request<{ apps: RegisteredApp[] }>("/api/v1/registry/apps", {
      method: "GET",
    });
    return res.apps;
  }

  /** Declare this app's ActionSpecs (idempotent upsert). */
  async register(actions: ActionSpec[]): Promise<RegisteredAction[]> {
    const res = await this.client.request<{ actions: RegisteredAction[] }>(
      "/api/v1/registry/actions",
      {
        method: "POST",
        body: { actions },
      },
    );
    return res.actions;
  }

  /** List registered actions (optionally one app), each with liveness. */
  async list(appId?: string): Promise<RegisteredAction[]> {
    const req: RequestOptions = { method: "GET" };
    if (appId) req.query = { appId };
    const res = await this.client.request<{ actions: RegisteredAction[] }>(
      "/api/v1/registry/actions",
      req,
    );
    return res.actions;
  }

  // ── Invoker side ────────────────────────────────────────────────────────────

  /** Enqueue an invocation for a (possibly other) app. `offline` if it has no channel. */
  invoke(appId: string, actionId: string, args?: unknown): Promise<InvokeResult> {
    const body: Record<string, unknown> = { appId, actionId };
    if (args !== undefined) body.args = args;
    return this.client.request<InvokeResult>("/api/v1/registry/invocations", {
      method: "POST",
      body,
    });
  }

  /** Poll a single invocation's result. */
  result(id: string): Promise<InvocationResult> {
    return this.client.request<InvocationResult>(
      `/api/v1/registry/invocations/${encodeURIComponent(id)}`,
      { method: "GET" },
    );
  }

  /** Poll until the invocation completes or the deadline passes. */
  async awaitResult(
    id: string,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<InvocationResult> {
    return pollUntil<InvocationResult>({
      timeoutMs: options.timeoutMs ?? 30_000,
      intervalMs: options.intervalMs ?? 400,
      poll: () => this.result(id),
      isDone: (r) => r.status === "done",
      // On timeout, return the last (still-pending) result — the caller checks
      // `status`. Without eagerDeadline, at least one poll always runs, so
      // `last` is always defined here.
      onTimeout: (last) => last as InvocationResult,
    });
  }

  // ── Serving side ────────────────────────────────────────────────────────────

  /** Register a push webhook (the server POSTs invocations to it), or clear it with "". */
  setWebhook(url: string): Promise<{ ok: boolean }> {
    return this.client.request<{ ok: boolean }>("/api/v1/registry/webhook", {
      method: "POST",
      body: { url },
    });
  }

  /** Pull (and clear) this app's pending invocations. Also marks the app live. */
  async pull(): Promise<Invocation[]> {
    const res = await this.client.request<{ invocations: Invocation[] }>(
      "/api/v1/registry/invocations/pending",
      { method: "GET" },
    );
    return res.invocations;
  }

  /** Post an invocation's result or error. */
  respond(
    id: string,
    payload: { result?: unknown } | { error: { code: string; message: string } },
  ): Promise<{ ok: boolean }> {
    return this.client.request<{ ok: boolean }>(
      `/api/v1/registry/invocations/${encodeURIComponent(id)}/respond`,
      { method: "POST", body: payload },
    );
  }

  /**
   * Serve registered actions: poll for work on an interval, dispatch to `handlers`, and
   * post each result. Returns a stop function. Unknown actions and handler throws are
   * reported back as errors so the invoker never hangs.
   */
  serve(
    handlers: Record<string, ActionHandler>,
    options: { intervalMs?: number } = {},
  ): () => void {
    const intervalMs = options.intervalMs ?? 500;
    let stopped = false;
    // Run one already-pulled job to completion, isolating BOTH the handler and the two
    // respond() calls — a network blip posting one result must not discard the rest of the
    // batch (pull() already cleared them server-side, so a thrown respond would strand them).
    const runJob = async (job: Invocation): Promise<void> => {
      try {
        const handler = handlers[job.actionId];
        if (!handler) {
          await this.respond(job.id, { error: { code: "unknown_action", message: job.actionId } });
          return;
        }
        try {
          const result = await handler(job.args);
          await this.respond(job.id, { result });
        } catch (err) {
          await this.respond(job.id, {
            error: {
              code: "handler_error",
              message: err instanceof Error ? err.message : "handler failed",
            },
          });
        }
      } catch {
        /* couldn't deliver this job's result — best effort; the invoker times out */
      }
    };
    const loop = async (): Promise<void> => {
      let backoff = intervalMs;
      while (!stopped) {
        try {
          const jobs = await this.pull();
          for (const job of jobs) {
            if (stopped) return;
            await runJob(job);
          }
          backoff = intervalMs; // healthy poll — reset backoff
        } catch {
          // Transient error (outage, expired creds) — back off exponentially so a broken
          // channel doesn't hammer the server at 2 req/s forever.
          backoff = Math.min(backoff * 2, 30_000);
        }
        await new Promise((res) => setTimeout(res, backoff));
      }
    };
    void loop();
    return () => {
      stopped = true;
    };
  }
}
