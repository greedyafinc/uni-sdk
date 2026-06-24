import type { TokenSet } from "../core/_internal/tokens";
import { UnifiedError } from "../core/errors";
import { challengeFor, generateState, generateVerifier } from "../core/_internal/pkce";
import { postTokenGrant } from "../core/_internal/token-endpoint";

export interface LoopbackHandle {
  readonly redirectUri: string;
  waitForCode(expectedState: string): Promise<string>;
}

export interface LoopbackServer {
  start(): Promise<LoopbackHandle>;
  stop(): Promise<void>;
}

export type OpenUrl = (url: string) => Promise<void> | void;

export interface BrowserSignInArgs {
  readonly clientId: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly openUrl: OpenUrl;
  readonly loopback: LoopbackServer;
}

/**
 * OAuth2 authorization-code + PKCE (S256) sign-in via the system browser and a
 * loopback redirect listener. Injectable `loopback` and `openUrl` adapters let
 * hosts (Node CLIs, Tauri/Electron desktops, test harnesses) wire platform I/O
 * without pulling `node:*` into browser bundles.
 */
export async function signInWithBrowser(args: BrowserSignInArgs): Promise<TokenSet> {
  const { clientId, authorizeUrl, tokenUrl, openUrl, loopback } = args;
  const fetchImpl = args.fetch ?? globalThis.fetch;
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
      fetch: fetchImpl,
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

/** Alias kept for internal/node callers that adopted the earlier name. */
export const runBrowserPkce = signInWithBrowser;
