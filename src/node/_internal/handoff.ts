import { type TokenSet, isTokenSet } from "../../core/_internal/tokens";
import { UnifiedError } from "../../core/errors";
import { coerceTimeoutMs, withTimeoutSignal } from "./fetch-timeout";

export interface HandoffArgs {
  readonly port: number;
  readonly clientId: string;
  readonly fetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  /**
   * Hard deadline in milliseconds for the whole handoff exchange (connect,
   * response, body). This is a localhost call to the desktop app — a healthy
   * endpoint answers in milliseconds, so a short deadline turns a stalled
   * endpoint (socket accepted, response never sent) into a clean
   * `handoff_unreachable` that the bootstrap ladder falls through, instead
   * of hanging bootstrap indefinitely. Only finite positive numbers are
   * honored; anything else falls back to the default (3000ms).
   */
  readonly timeoutMs?: number;
  /**
   * Per-launch shared secret required by the desktop app's /handoff endpoint,
   * forwarded as the `x-handoff-token` header. The node client sources this
   * from its EnvReader (UNIFIEDAI_HANDOFF_TOKEN by default) so hosts/tests
   * can inject it. Absent → no header (back-compat with older desktops).
   */
  readonly handoffToken?: string;
}

const DEFAULT_HANDOFF_TIMEOUT_MS = 3000;

export async function requestHandoff(args: HandoffArgs): Promise<TokenSet> {
  const { port, clientId, fetch, signal, handoffToken } = args;
  const url = `http://127.0.0.1:${port}/handoff`;
  // The desktop app injects UNIFIEDAI_HANDOFF_TOKEN into the processes it
  // spawns and its /handoff endpoint requires this per-launch shared secret.
  // The caller supplies it (the node client reads it through its EnvReader);
  // when absent we preserve the prior behavior (no header) for back-compat.
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (handoffToken) {
    headers["x-handoff-token"] = handoffToken;
  }

  // Chain the caller's signal (if any) into the deadline signal so either can
  // abort. An abort from either source lands in the fetch catch below and maps
  // to handoff_unreachable — the code tryHandoff already treats as
  // fall-through-able. The body read stays under the same deadline: an
  // endpoint that sends headers then stalls the body aborts and is treated
  // like any other malformed/unreachable handoff.
  return withTimeoutSignal(
    coerceTimeoutMs(args.timeoutMs, DEFAULT_HANDOFF_TIMEOUT_MS),
    async (deadlineSignal) => {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ client_id: clientId }),
          signal: deadlineSignal,
        });
      } catch {
        throw new UnifiedError("handoff_unreachable", `desktop handoff at ${url} unreachable`);
      }
      if (res.status === 404) {
        throw new UnifiedError(
          "app_not_installed",
          `client_id ${clientId} not installed on desktop`,
          404,
        );
      }
      if (!res.ok) {
        throw new UnifiedError(
          "handoff_unreachable",
          `desktop handoff returned ${res.status}`,
          res.status,
        );
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new UnifiedError("handoff_unreachable", "desktop handoff returned malformed payload");
      }
      if (!isTokenSet(body)) {
        throw new UnifiedError("handoff_unreachable", "desktop handoff returned malformed payload");
      }
      return body;
    },
    signal,
  );
}
