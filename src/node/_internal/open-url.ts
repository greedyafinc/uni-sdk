import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { OpenUrl } from "../../auth/browser-sign-in";
import { UnifiedError } from "../../core/errors";

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
export function makeOpenUrl(spawnImpl: typeof spawn, platformImpl: typeof platform): OpenUrl {
  return (url: string): Promise<void> => {
    const p = platformImpl();
    const cmd = p === "darwin" ? "open" : p === "win32" ? "rundll32" : "xdg-open";
    const args = p === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    return new Promise((resolve, reject) => {
      const child = spawnImpl(cmd, args, { detached: true, stdio: "ignore" });
      // Without an "error" listener, a missing opener binary (e.g. no
      // xdg-open in a minimal container) raises an uncaught "error" event and
      // crashes the host process. Reject instead so sign-in fails cleanly.
      child.once("error", (cause) => {
        reject(
          new UnifiedError(
            "browser_open_failed",
            `Failed to open browser via "${cmd}": ${cause.message}`,
          ),
        );
      });
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  };
}

export const defaultOpenUrl: OpenUrl = makeOpenUrl(spawn, platform);
