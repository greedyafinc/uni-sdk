import { drainResponse } from "../../core/_internal/http-errors";
import { type TokenSet, isTokenSet } from "../../core/_internal/tokens";
import type { UnifiedError } from "../../core/errors";

export interface PostTokenGrantArgs {
  readonly tokenUrl: string;
  readonly body: Record<string, string>;
  readonly fetch: typeof globalThis.fetch;
  readonly makeError: (message: string, status?: number) => UnifiedError;
}

export async function postTokenGrant(args: PostTokenGrantArgs): Promise<TokenSet> {
  const { tokenUrl, body, fetch, makeError } = args;
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw makeError(`token endpoint ${tokenUrl} unreachable`);
  }
  if (!res.ok) {
    await drainResponse(res);
    throw makeError(`token endpoint returned ${res.status}`, res.status);
  }
  const parsed = (await res.json()) as unknown;
  if (!isTokenSet(parsed)) {
    throw makeError("token endpoint returned malformed payload");
  }
  return parsed;
}
