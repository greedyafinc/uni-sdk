import { UnifiedError } from "../errors";
import { challengeFor, generateState, generateVerifier } from "./pkce";
import { type TokenSet, isTokenSet } from "./tokens";

export interface LoopbackHandle {
  readonly redirectUri: string;
  waitForCode(expectedState: string): Promise<string>;
}

export interface LoopbackServer {
  start(): Promise<LoopbackHandle>;
  stop(): Promise<void>;
}

export type OpenUrl = (url: string) => Promise<void> | void;

export interface BrowserPkceArgs {
  readonly clientId: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly openUrl: OpenUrl;
  readonly loopback: LoopbackServer;
}

export async function runBrowserPkce(args: BrowserPkceArgs): Promise<TokenSet> {
  const { clientId, authorizeUrl, tokenUrl, fetch, openUrl, loopback } = args;
  const verifier = generateVerifier();
  const challenge = await challengeFor(verifier);
  const state = generateState();
  const handle = await loopback.start();
  try {
    const url = new URL(authorizeUrl);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", handle.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    await openUrl(url.toString());
    const code = await handle.waitForCode(state);
    let res: Response;
    try {
      res = await fetch(tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: handle.redirectUri,
        }),
      });
    } catch {
      throw new UnifiedError(
        "auth_token_exchange_failed",
        `token endpoint ${tokenUrl} unreachable`,
      );
    }
    if (!res.ok) {
      throw new UnifiedError(
        "auth_token_exchange_failed",
        `token endpoint returned ${res.status}`,
        res.status,
      );
    }
    const body = (await res.json()) as unknown;
    if (!isTokenSet(body)) {
      throw new UnifiedError(
        "auth_token_exchange_failed",
        "token endpoint returned malformed payload",
      );
    }
    return body;
  } finally {
    await loopback.stop();
  }
}
