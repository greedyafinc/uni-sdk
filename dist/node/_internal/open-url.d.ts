import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { OpenUrl } from "../../auth/browser-sign-in.js";
/**
 * Build an `OpenUrl` from injectable `spawn`/`platform` implementations so
 * tests can exercise per-platform argument construction and the failure path
 * without global module mocks.
 *
 * Platform commands are chosen so the URL is always passed as a plain process
 * argument, never through a shell. In particular, Windows must NOT go through
 * `cmd /c start`: cmd.exe re-parses its command line, so the unquoted `&`
 * separators in OAuth query strings truncate the URL and execute the remainder
 * as shell commands. `rundll32 url.dll,FileProtocolHandler` receives the URL
 * verbatim via CreateProcess, so `&`, `^`, and `%` are inert.
 */
export declare function makeOpenUrl(spawnImpl: typeof spawn, platformImpl: typeof platform): OpenUrl;
export declare const defaultOpenUrl: OpenUrl;
//# sourceMappingURL=open-url.d.ts.map