import { UnifiedError } from "../../core/errors";
import { challengeFor, generateState, generateVerifier } from "./pkce";
import { postTokenGrant } from "./token-endpoint";
import type { TokenSet } from "../../core/_internal/tokens";

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
    return await postTokenGrant({
      tokenUrl,
      fetch,
      body: {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: handle.redirectUri,
      },
      makeError: (msg, status) => new UnifiedError("auth_token_exchange_failed", msg, status),
    });
  } finally {
    await loopback.stop();
  }
}
