import type { TokenSet } from "../core/_internal/tokens.js";
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
export declare function signInWithBrowser(args: BrowserSignInArgs): Promise<TokenSet>;
/** Alias kept for internal/node callers that adopted the earlier name. */
export declare const runBrowserPkce: typeof signInWithBrowser;
//# sourceMappingURL=browser-sign-in.d.ts.map