import { describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { platform } from "node:os";
import { UnifiedError } from "../../src/core/errors";
import { makeOpenUrl } from "../../src/node/_internal/open-url";

// Unit coverage for the system-browser opener behind OAuth sign-in. Two
// regressions are pinned here:
//   1. Windows must never route the URL through cmd.exe (`cmd /c start`):
//      cmd re-parses its command line, so the unquoted `&` separators in an
//      OAuth authorize query string truncate the URL and execute the rest as
//      shell commands. The URL must be a plain argv entry to rundll32.
//   2. A missing opener binary (ENOENT) must reject the returned promise with
//      a typed UnifiedError instead of raising an uncaught ChildProcess
//      "error" event that crashes the host process.

// Representative authorize URL: `&`-joined params plus `%`-escapes, the
// characters cmd.exe treats specially.
const AUTHORIZE_URL =
  "https://auth.example.com/authorize?client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A9151%2Fcallback&response_type=code&state=xyz^42";

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

class FakeChild extends EventEmitter {
  unrefCalls = 0;
  unref(): void {
    this.unrefCalls += 1;
  }
}

function only<T>(items: readonly T[]): T {
  const item = items[0];
  if (items.length !== 1 || item === undefined) {
    throw new Error(`expected exactly one item, got ${items.length}`);
  }
  return item;
}

function harness(platformName: NodeJS.Platform, drive: (child: FakeChild) => void) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const fakeSpawn = ((cmd: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ cmd, args, options });
    const child = new FakeChild();
    children.push(child);
    // Settle asynchronously, like a real ChildProcess.
    queueMicrotask(() => drive(child));
    return child;
  }) as unknown as typeof spawn;
  const fakePlatform = (() => platformName) as typeof platform;
  return { calls, children, openUrl: makeOpenUrl(fakeSpawn, fakePlatform) };
}

describe("defaultOpenUrl (via makeOpenUrl)", () => {
  test("win32: passes the full URL as one argv entry to rundll32, never cmd.exe", async () => {
    const { calls, openUrl } = harness("win32", (child) => child.emit("spawn"));
    await openUrl(AUTHORIZE_URL);
    const call = only(calls);
    expect(call.cmd).toBe("rundll32");
    expect(call.args).toEqual(["url.dll,FileProtocolHandler", AUTHORIZE_URL]);
    // The URL must survive verbatim — & and % intact, no quoting/mangling.
    expect(call.args[1]).toContain("&state=");
    expect(call.args[1]).toContain("%3A%2F%2F");
    // No shell: cmd.exe (or shell: true) would re-parse `&` as a separator.
    expect(call.cmd).not.toBe("cmd");
    expect(call.options.shell).toBeUndefined();
    expect(call.options).toEqual({ detached: true, stdio: "ignore" });
  });

  test("darwin uses `open <url>`; linux uses `xdg-open <url>`", async () => {
    for (const [platformName, cmd] of [
      ["darwin", "open"],
      ["linux", "xdg-open"],
    ] as const) {
      const { calls, openUrl } = harness(platformName, (child) => child.emit("spawn"));
      await openUrl(AUTHORIZE_URL);
      expect(only(calls).cmd).toBe(cmd);
      expect(only(calls).args).toEqual([AUTHORIZE_URL]);
    }
  });

  test("unrefs the child once spawned so it cannot pin the event loop", async () => {
    const { children, openUrl } = harness("linux", (child) => child.emit("spawn"));
    await openUrl(AUTHORIZE_URL);
    expect(only(children).unrefCalls).toBe(1);
  });

  test("missing opener binary rejects with a typed UnifiedError instead of crashing", async () => {
    const enoent = Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" });
    const { openUrl } = harness("linux", (child) => child.emit("error", enoent));
    await (openUrl(AUTHORIZE_URL) as Promise<void>).then(
      () => {
        throw new Error("expected rejection");
      },
      (err: unknown) => {
        expect(err).toBeInstanceOf(UnifiedError);
        expect((err as UnifiedError).code).toBe("browser_open_failed");
        expect((err as UnifiedError).message).toContain("xdg-open");
        expect((err as UnifiedError).message).toContain("ENOENT");
      },
    );
  });

  test("a late error after successful spawn does not throw or reject", async () => {
    const { children, openUrl } = harness("darwin", (child) => child.emit("spawn"));
    await openUrl(AUTHORIZE_URL);
    // Promise already resolved; a subsequent error event must be a no-op
    // (settled promise ignores reject) rather than an uncaught emitter error.
    expect(() => only(children).emit("error", new Error("late failure"))).not.toThrow();
  });
});
