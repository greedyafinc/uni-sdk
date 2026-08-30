import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// The loopback agent-bridge client (agent-bridge.md) reads/writes localStorage
// (absent under bun) and talks to the desktop with plain `fetch`. Both are
// stubbed here; nothing else in the module needs mocking, which is the point of
// keeping it dependency-free and browser-safe.
function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as unknown as Storage;
}
(globalThis as { localStorage?: Storage }).localStorage = makeStorage();

const { connectDesktop, resolveLocalAgentSource, resolveSourceFor, _resetLocalAgentState } =
  await import("../../src/localAgents/transport");
const { BRIDGE_PORTS, bridgeToken, clearBridgeToken, hasBridgeToken, pairBridge } = await import(
  "../../src/localAgents/bridgeClient"
);
const { dispatchFrame, discoverBridge, invalidateBridgePort, openRunEvents, bridgeDetect } =
  await import("../../src/localAgents/bridgeClient");
const { configureLocalAgents } = await import("../../src/localAgents/config");

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

const calls: Call[] = [];
type Responder = (call: Call) => { status?: number; body?: unknown } | Response | undefined;
let responder: Responder = () => undefined;

const realFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  responder = () => undefined;
  localStorage.clear();
  invalidateBridgePort();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    calls.push(call);
    const answer = responder(call);
    if (!answer) throw new Error("connection refused");
    if (answer instanceof Response) return answer;
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const healthy = (port: number) => `http://127.0.0.1:${port}/health`;
const SERVICE_BODY = { service: "unified-agent-bridge", version: 1 };

const online: Responder = (c) => (c.url === healthy(47825) ? { body: SERVICE_BODY } : undefined);

/** A desktop that is up, answering `/pair` with `answer`. */
function pairs(answer: { body?: unknown; status?: number }): Responder {
  return (c) => online(c) ?? (c.url.endsWith("/pair") ? answer : undefined);
}

/** Every `/pair` body sent so far, parsed, in order. */
function pairBodies(): Array<{ name?: string; silent?: boolean; token?: string }> {
  return calls
    .filter((c) => c.url.endsWith("/pair"))
    .map((c) => JSON.parse(c.body ?? "{}") as { name?: string; silent?: boolean; token?: string });
}

describe("bridge discovery", () => {
  test("probes the whole range and remembers the port that answered", async () => {
    responder = (c) => (c.url === healthy(47827) ? { body: SERVICE_BODY } : undefined);

    expect(await discoverBridge()).toBe(47827);
    expect(localStorage.getItem("unified.agentBridge.port")).toBe("47827");
    expect(calls.map((c) => c.url)).toEqual([healthy(47825), healthy(47826), healthy(47827)]);
  });

  test("tries the remembered port first on the next load", async () => {
    localStorage.setItem("unified.agentBridge.port", "47829");
    responder = (c) => (c.url === healthy(47829) ? { body: SERVICE_BODY } : undefined);

    expect(await discoverBridge()).toBe(47829);
    expect(calls).toHaveLength(1);
  });

  test("a foreign server on the port is not the bridge", async () => {
    responder = () => ({ body: { service: "something-else" } });
    expect(await discoverBridge()).toBeNull();
    expect(calls).toHaveLength(BRIDGE_PORTS.length);
    expect(localStorage.getItem("unified.agentBridge.port")).toBeNull();
  });

  test("returns null when nothing is listening", async () => {
    expect(await discoverBridge()).toBeNull();
  });
});

describe("pairing", () => {
  test("stores the minted token", async () => {
    responder = (c) =>
      online(c) ?? (c.url.endsWith("/pair") ? { body: { token: "tok-1" } } : undefined);

    expect(hasBridgeToken()).toBe(false);
    await pairBridge("Notes (localhost:5173)");
    expect(bridgeToken()).toBe("tok-1");
    expect(hasBridgeToken()).toBe(true);

    const pair = calls.find((c) => c.url.endsWith("/pair"));
    expect(pair?.method).toBe("POST");
    // A user-initiated pair is NOT silent: it is allowed to raise the modal.
    expect(JSON.parse(pair?.body ?? "{}")).toEqual({ name: "Notes (localhost:5173)" });
  });

  test("a declined pairing is a readable error, not an opaque network failure", async () => {
    responder = pairs({ status: 403 });
    await expect(pairBridge("x")).rejects.toThrow(/declined/i);
    expect(hasBridgeToken()).toBe(false);
  });

  test("silent pairing sends the silent flag", async () => {
    responder = (c) =>
      online(c) ?? (c.url.endsWith("/pair") ? { body: { token: "t" } } : undefined);
    await pairBridge("x", true);
    expect(pairBodies()[0]).toEqual({ name: "x", silent: true });
  });

  test("clearBridgeToken forgets it", async () => {
    responder = (c) =>
      online(c) ?? (c.url.endsWith("/pair") ? { body: { token: "t" } } : undefined);
    await pairBridge("x");
    clearBridgeToken();
    expect(hasBridgeToken()).toBe(false);
  });

  // The refresh bug: the token is in localStorage and the desktop's approval is
  // on disk, so pairing survives a page reload. Re-prompting for a decision the
  // user already made is the thing to avoid.
  test("connectDesktop re-mints SILENTLY when this origin already holds a token", async () => {
    responder = (c) =>
      online(c) ?? (c.url.endsWith("/pair") ? { body: { token: "tok-2" } } : undefined);
    _resetLocalAgentState();
    await pairBridge("first time");
    calls.length = 0;

    await connectDesktop("Notes");
    expect(pairBodies()[0]).toEqual({ name: "Notes", silent: true });
  });

  test("…but falls back to a real prompt when the silent re-mint is refused", async () => {
    // Approval revoked on the desktop while we still held a token: the silent
    // attempt 403s, and THEN a modal is the right answer rather than a dead end.
    responder = (c) =>
      online(c) ?? (c.url.endsWith("/pair") ? { body: { token: "stale" } } : undefined);
    _resetLocalAgentState();
    await pairBridge("first time");
    calls.length = 0;

    // Only now does the desktop start refusing the silent re-mint.
    let seen = 0;
    responder = (c) => {
      const o = online(c);
      if (o) return o;
      if (!c.url.endsWith("/pair")) return undefined;
      seen++;
      return seen === 1 ? { status: 403 } : { body: { token: "re-approved" } };
    };

    await connectDesktop("Notes");
    const bodies = calls
      .filter((c) => c.url.endsWith("/pair"))
      .map((c) => JSON.parse(c.body ?? "{}") as { silent?: boolean });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.silent).toBe(true);
    expect(bodies[1]?.silent).toBeUndefined();
    expect(bridgeToken()).toBe("re-approved");
  });

  // The desktop, not localStorage, is the source of truth for approval. A load
  // that starts with no token must ASK — an approved origin gets its token back
  // with no modal, so the user is never re-prompted for a decision they made.
  test("a tokenless load adopts the desktop's existing approval, silently", async () => {
    responder = (c) =>
      online(c) ?? (c.url.endsWith("/pair") ? { body: { token: "restored" } } : undefined);
    _resetLocalAgentState();
    clearBridgeToken();
    expect(hasBridgeToken()).toBe(false);

    expect(await resolveLocalAgentSource()).toEqual({ kind: "bridge" });
    expect(bridgeToken()).toBe("restored");
    expect(pairBodies()[0]?.silent).toBe(true);
  });

  test("an origin the desktop does NOT approve stays disconnected, with no modal", async () => {
    responder = pairs({ status: 403 });
    _resetLocalAgentState();
    clearBridgeToken();

    expect(await resolveLocalAgentSource()).toBeNull();
    expect(hasBridgeToken()).toBe(false);
    // Refused silently: a 403 here must never surface as a thrown error or a modal.
    expect(pairBodies()[0]?.silent).toBe(true);
  });

  test("a refused origin is asked ONCE per page, not on every resolve", async () => {
    responder = pairs({ status: 403 });
    _resetLocalAgentState();
    clearBridgeToken();

    expect(await resolveLocalAgentSource()).toBeNull();
    const after = calls.filter((c) => c.url.endsWith("/pair")).length;
    expect(after).toBeGreaterThan(0);

    // Every surface resolves for itself, and each resolve used to repeat the
    // forced port scan and the 403. The verdict is stable until something the
    // user does could change it.
    await resolveSourceFor({ kind: "auto" });
    await resolveSourceFor({ kind: "bridge" });
    expect(calls.filter((c) => c.url.endsWith("/pair"))).toHaveLength(after);
  });

  test("a direct pairBridge() call stays non-silent", async () => {
    responder = (c) =>
      online(c) ?? (c.url.endsWith("/pair") ? { body: { token: "tok-1" } } : undefined);
    await pairBridge("Test browser");
    const pair = calls.find((c) => c.url.endsWith("/pair"));
    const body = JSON.parse(pair?.body ?? "{}") as { name: string; silent?: boolean };
    expect(body.silent).toBeUndefined();
  });
});

/**
 * The account grant (agent-bridge.md § The trust boundary). The client's whole
 * part in it is sending its own credential; the host does the deciding.
 */
describe("pairing on an account credential", () => {
  afterEach(() => {
    configureLocalAgents({ client: undefined });
  });

  /** A client whose `accessToken()` is all `unifiedToken()` reads. */
  function signedInAs(token: string): void {
    configureLocalAgents({
      client: { accessToken: async () => token } as unknown as Parameters<
        typeof configureLocalAgents
      >[0]["client"],
    });
  }

  test("the caller's credential rides along on /pair", async () => {
    signedInAs("account-token");
    responder = pairs({ body: { token: "tok-1" } });
    await pairBridge("Notes", true);
    expect(pairBodies()[0]?.token).toBe("account-token");
  });

  test("a signed-out surface simply omits it, and pairs the old way", async () => {
    responder = pairs({ body: { token: "tok-1" } });
    await pairBridge("Notes", true);
    expect(pairBodies()[0]).not.toHaveProperty("token");
  });

  /**
   * The behavior change that matters: a signed-in surface connects on page load
   * with no user action. Before, a silent pair could only RESTORE a connection
   * an approved origin already had, so this resolved to null.
   */
  test("resolving connects a signed-in surface that has never paired", async () => {
    signedInAs("account-token");
    _resetLocalAgentState();
    clearBridgeToken();
    responder = pairs({ body: { token: "tok-1" } });

    expect(await resolveLocalAgentSource()).toEqual({ kind: "bridge" });
    expect(hasBridgeToken()).toBe(true);
    // Never prompts: the resolve path is silent, whatever the host decides.
    expect(pairBodies().every((b) => b.silent === true)).toBe(true);
  });

  /**
   * The other half of the refusal cache: a page refused while signed OUT must be
   * reconsidered once it signs in, or a surface that authenticates a moment
   * after load would be stranded for the life of the page.
   */
  test("a refusal while signed out is reconsidered once a credential appears", async () => {
    _resetLocalAgentState();
    clearBridgeToken();
    responder = pairs({ status: 403 });
    expect(await resolveLocalAgentSource()).toBeNull();
    const refused = pairBodies().length;

    signedInAs("account-token");
    responder = pairs({ body: { token: "tok-1" } });
    expect(await resolveSourceFor({ kind: "bridge" })).toEqual({ kind: "bridge" });
    expect(pairBodies().length).toBeGreaterThan(refused);
  });
});

describe("resilience", () => {
  test("a network-level failure invalidates the cached port and re-probes once, then retries", async () => {
    localStorage.setItem("unified.agentBridge.token", "tok");
    let bridgePort = 47825;
    responder = (c) => {
      if (c.url.endsWith("/health")) {
        return c.url === healthy(bridgePort) ? { body: SERVICE_BODY } : undefined;
      }
      if (c.url.endsWith("/detect")) {
        return c.url.startsWith(`http://127.0.0.1:${bridgePort}`)
          ? {
              body: {
                claudeCode: { found: true, path: "/usr/bin/claude" },
                cursor: { found: false, path: null },
              },
            }
          : undefined; // connection refused on the now-stale cached port
      }
      return undefined;
    };

    expect(await discoverBridge()).toBe(47825);

    // The desktop restarted on a different port; the cached one now refuses.
    bridgePort = 47827;

    const result = await bridgeDetect();
    expect(result.claudeCode.found).toBe(true);
    expect(await discoverBridge()).toBe(47827);
  });
});

describe("no token means no pairing prompt", () => {
  // The rule the whole consent model rests on: a page that has never paired
  // must never issue a request that could raise a modal on somebody's desktop.
  test("an authenticated call with no stored token never touches the wire", async () => {
    responder = online;
    await expect(bridgeDetect()).rejects.toThrow(/Not connected/i);
    expect(calls.filter((c) => c.url.endsWith("/pair"))).toHaveLength(0);
    expect(calls.filter((c) => c.url.endsWith("/detect"))).toHaveLength(0);
  });

  test("opening a run stream with no stored token never touches the wire", async () => {
    responder = online;
    await expect(openRunEvents("run-1", { onLine: () => {}, onExit: () => {} })).rejects.toThrow(
      /Not connected/i,
    );
    expect(calls).toHaveLength(0);
  });

  test("a 401 on an authenticated call re-pairs SILENTLY and retries once", async () => {
    localStorage.setItem("unified.agentBridge.token", "stale");
    let detectHits = 0;
    responder = (c) => {
      if (c.url === healthy(47825)) return { body: SERVICE_BODY };
      if (c.url.endsWith("/pair")) return { body: { token: "fresh" } };
      if (c.url.endsWith("/detect")) {
        detectHits++;
        return detectHits === 1
          ? { status: 401 }
          : {
              body: {
                claudeCode: { found: true, path: "/c" },
                cursor: { found: false, path: null },
              },
            };
      }
      return undefined;
    };

    const result = await bridgeDetect();
    expect(result.claudeCode.found).toBe(true);
    const pair = calls.find((c) => c.url.endsWith("/pair"));
    // Silent: an origin whose approval was REVOKED gets a clean 403 instead of
    // raising an unprompted modal at page load.
    expect(JSON.parse(pair?.body ?? "{}").silent).toBe(true);
    expect(bridgeToken()).toBe("fresh");
    expect(detectHits).toBe(2);
  });
});

describe("run event stream", () => {
  function sseResponse(chunks: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }

  test("parses named SSE events into handler calls", async () => {
    localStorage.setItem("unified.agentBridge.token", "tok");
    responder = (c) => {
      if (c.url === healthy(47825)) return { body: SERVICE_BODY };
      if (c.url.includes("/events")) {
        return sseResponse([
          'event: line\ndata: {"line":"{\\"type\\":\\"x\\"}"}\n\n',
          'event: exit\ndata: {"code":0,"canceled":false,"stderr":""}\n\n',
        ]);
      }
      return undefined;
    };

    const lines: string[] = [];
    const exits: Array<{ code: number | null; canceled: boolean; stderr: string }> = [];
    await openRunEvents("run-1", {
      onLine: (l) => lines.push(l),
      onExit: (e) => exits.push(e),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(lines).toEqual(['{"type":"x"}']);
    expect(exits).toEqual([{ code: 0, canceled: false, stderr: "" }]);
    // The stream is read with fetch + a bearer header — EventSource cannot.
    const ev = calls.find((c) => c.url.includes("/events"));
    expect(ev?.headers.Authorization).toBe("Bearer tok");
  });

  test("a stream that ends without `exit` is a run error, not a hang", async () => {
    localStorage.setItem("unified.agentBridge.token", "tok");
    responder = (c) => {
      if (c.url === healthy(47825)) return { body: SERVICE_BODY };
      if (c.url.includes("/events")) return sseResponse(['event: line\ndata: {"line":"a"}\n\n']);
      return undefined;
    };
    let error: string | null = null;
    await openRunEvents("run-1", {
      onLine: () => {},
      onExit: () => {},
      onError: (m) => {
        error = m;
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(error).toMatch(/ended before the run finished/);
  });

  test("a stream that delivers exit does not report an error", async () => {
    localStorage.setItem("unified.agentBridge.token", "tok");
    responder = (c) => {
      if (c.url === healthy(47825)) return { body: SERVICE_BODY };
      if (c.url.includes("/events")) {
        return sseResponse(['event: exit\ndata: {"code":0,"canceled":false,"stderr":""}\n\n']);
      }
      return undefined;
    };
    const errors: string[] = [];
    let exited = false;
    await openRunEvents("run-1", {
      onLine: () => {},
      onExit: () => {
        exited = true;
      },
      onError: (m) => errors.push(m),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(exited).toBe(true);
    expect(errors).toEqual([]);
  });
});

describe("SSE frame dispatch", () => {
  test("routes each named event, tolerating CRLF and comments", () => {
    const seen: string[] = [];
    const handlers = {
      onLine: (l: string) => seen.push(`line:${l}`),
      onExit: (e: { code: number | null }) => seen.push(`exit:${e.code}`),
      onMcpList: (id: string) => seen.push(`list:${id}`),
      onMcpCall: (id: string, name: string) => seen.push(`call:${id}:${name}`),
    };
    dispatchFrame(': keep-alive\r\nevent: line\r\ndata: {"line":"hello"}', handlers);
    dispatchFrame('event: mcp-list\ndata: {"id":"m1"}', handlers);
    dispatchFrame('event: mcp-call\ndata: {"id":"m2","name":"t","arguments":{}}', handlers);
    dispatchFrame('event: exit\ndata: {"code":3,"canceled":false,"stderr":""}', handlers);
    expect(seen).toEqual(["line:hello", "list:m1", "call:m2:t", "exit:3"]);
  });

  test("malformed data is dropped rather than thrown", () => {
    let hit = false;
    dispatchFrame("event: line\ndata: not-json", {
      onLine: () => {
        hit = true;
      },
      onExit: () => {},
    });
    expect(hit).toBe(false);
  });

  test("exit tolerates a null exit code (killed by a signal)", () => {
    const seen: Array<{ code: number | null; canceled: boolean; stderr: string }> = [];
    dispatchFrame('event: exit\ndata: {"canceled":true}', {
      onLine: () => {},
      onExit: (e) => seen.push(e),
    });
    expect(seen).toEqual([{ code: null, canceled: true, stderr: "" }]);
  });
});
