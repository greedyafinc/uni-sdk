import { type TokenSet, isTokenSet } from "../../core/_internal/tokens";
import { UnifiedError } from "../../core/errors";

export interface HandoffArgs {
  readonly port: number;
  readonly clientId: string;
  readonly fetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export async function requestHandoff(args: HandoffArgs): Promise<TokenSet> {
  const { port, clientId, fetch, signal } = args;
  const url = `http://127.0.0.1:${port}/handoff`;
  // The desktop app injects UNIFIEDAI_HANDOFF_TOKEN into the processes it
  // spawns and its /handoff endpoint requires this per-launch shared secret.
  // When the env var is present we forward it as the x-handoff-token header;
  // when absent we preserve the prior behavior (no header) for back-compat.
  const handoffToken = process.env.UNIFIEDAI_HANDOFF_TOKEN;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (handoffToken) {
    headers["x-handoff-token"] = handoffToken;
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ client_id: clientId }),
      ...(signal ? { signal } : {}),
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
  const body = (await res.json()) as unknown;
  if (!isTokenSet(body)) {
    throw new UnifiedError("handoff_unreachable", "desktop handoff returned malformed payload");
  }
  return body;
}
