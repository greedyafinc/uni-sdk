import { UnifiedError } from "../errors";
import { type TokenSet, isTokenSet } from "./tokens";

export interface HandoffArgs {
  readonly port: number;
  readonly clientId: string;
  readonly fetch: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
}

export async function requestHandoff(args: HandoffArgs): Promise<TokenSet> {
  const { port, clientId, fetch, signal } = args;
  const url = `http://127.0.0.1:${port}/handoff`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
