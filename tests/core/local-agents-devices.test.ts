import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// PER-SURFACE compute selection: the device listing a picker renders, and the
// per-call `source` override that lets two surfaces run on two machines at
// once. The bridge is a fake desktop over `fetch` (same wire as
// local-agents.test.ts); the relay is a fake socket plus a fake `GET /hosts`
// listing (same shape as local-agents-relay.test.ts).

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

class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

const realWs = (globalThis as { WebSocket?: unknown }).WebSocket;
(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;

const { UnifiedAI } = await import("../../src/core/client");
const { configureLocalAgents } = await import("../../src/localAgents/config");
const { invalidateCursorModels, listLocalModels } = await import("../../src/localAgents/catalog");
const {
  _resetLocalAgentState,
  checkDesktopAvailable,
  detectAgents,
  getLocalAgentStatus,
  listLocalAgentDevices,
  refreshLocalAgentDevices,
  resolveLocalAgentSource,
  resolveSourceFor,
  startAgentRun,
} = await import("../../src/localAgents/transport");

const HEALTH = "http://127.0.0.1:47825/health";
const SERVICE_BODY = { service: "unified-agent-bridge", version: 1 };

interface Call {
  url: string;
  method: string;
}

/** A fake desktop + relay listing. `bridgeUp` false = nothing on loopback. */
class FakeWorld {
  calls: Call[] = [];
  bridgeUp = true;
  claudeCode = { found: true, path: "/usr/local/bin/claude" };
  cursor = { found: false, path: null as string | null };
  hosts: Array<Record<string, unknown>> = [];
  /** What the AUTHENTICATED `/detect` says this machine is. Null = an older desktop. */
  deviceId: string | null = null;
  deviceName: string | null = null;

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    this.calls.push({ url, method: init?.method ?? "GET" });

    if (url.includes("/relay/hosts")) return this.json(this.hosts);
    if (url.endsWith("/health")) {
      if (!this.bridgeUp || url !== HEALTH) throw new Error(`connection refused: ${url}`);
      return this.json(SERVICE_BODY);
    }
    if (url.endsWith("/detect"))
      return this.json({
        claudeCode: this.claudeCode,
        cursor: this.cursor,
        deviceId: this.deviceId,
        deviceName: this.deviceName,
      });
    if (url.includes("/cursor/models")) return this.json({ output: "auto\n", code: 0, stderr: "" });
    if (url.includes("/events")) {
      const stream = new ReadableStream<Uint8Array>({ start: () => {} });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.endsWith("/runs")) return this.json({ ok: true });
    throw new Error(`connection refused: ${url}`);
  };

  private json(value: unknown): Response {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}

let world: FakeWorld;
const realFetch = globalThis.fetch;

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Pretend this origin paired earlier — what lets auto-select use the bridge. */
function paired(): void {
  localStorage.setItem("unified.agentBridge.token", "tok");
}

function host(deviceId: string, deviceName: string, caps?: Record<string, unknown>) {
  return {
    deviceId,
    deviceName,
    ...(caps ? { capabilities: caps } : {}),
  };
}

const NO_HANDLERS = {
  onLine: () => {},
  onExit: () => {},
  onMcpList: () => [],
  onMcpCall: async () => ({ content: [], isError: false }),
};

const RUN_ARGS = {
  runId: "run-1",
  prompt: "hi",
  model: "opus",
  resume: null,
  workspace: null,
  trustWorkspace: false,
  extraDirs: [],
  mcp: false,
};

beforeEach(() => {
  world = new FakeWorld();
  globalThis.fetch = world.fetch as typeof fetch;
  FakeSocket.last = null;
  localStorage.clear();
  _resetLocalAgentState();
  invalidateCursorModels();
  configureLocalAgents({
    client: new UnifiedAI({ apiUrl: "http://api.test", token: "uapi_dev" }),
    wsBaseUrl: "http://api.test/api/v1",
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  _resetLocalAgentState();
  configureLocalAgents({ client: undefined, wsBaseUrl: undefined });
});

process.on("beforeExit", () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = realWs;
});

describe("listLocalAgentDevices", () => {
  test("is empty when nothing is reachable", async () => {
    world.bridgeUp = false;
    expect(await refreshLocalAgentDevices()).toEqual([]);
    expect(listLocalAgentDevices()).toEqual([]);
  });

  test("a paired, available bridge is the only entry when there are no hosts", async () => {
    paired();
    const devices = await refreshLocalAgentDevices();
    expect(devices).toEqual([
      {
        id: "bridge",
        kind: "bridge",
        name: "This computer",
        online: true,
        // From the authenticated `/detect`, which the probe now also reads.
        capabilities: { claudeCode: true, cursor: false },
        pref: { kind: "bridge" },
      },
    ]);
  });

  test("the bridge and the SAME machine's relay host collapse into one row", async () => {
    // The desktop registers ITSELF as a relay host, so without correlation the
    // user saw their own computer twice: once as the bridge, once by name.
    paired();
    world.deviceId = "dev-self";
    world.deviceName = "Matthew's Mac";
    world.cursor = { found: true, path: "/usr/local/bin/cursor-agent" };
    world.hosts = [
      host("dev-self", "Matthew's Mac", { claudeCode: { found: true }, cursor: { found: false } }),
      host("dev-2", "Studio", { claudeCode: { found: true } }),
    ];
    const devices = await refreshLocalAgentDevices();
    expect(devices).toEqual([
      {
        id: "bridge",
        kind: "bridge",
        name: "This computer",
        online: true,
        machineName: "Matthew's Mac",
        // Merged: the relay listing knew Claude Code, `/detect` knew Cursor.
        capabilities: { claudeCode: true, cursor: true },
        // Best available transport for that machine — loopback, not the relay.
        pref: { kind: "bridge" },
      },
      {
        id: "dev-2",
        kind: "relay",
        name: "Studio",
        online: true,
        capabilities: { claudeCode: true, cursor: false },
        pref: { kind: "relay", deviceId: "dev-2" },
      },
    ]);
  });

  test("a bridge whose machine is NOT in the host listing collapses nothing", async () => {
    paired();
    world.deviceId = "dev-self";
    world.deviceName = "Matthew's Mac";
    world.hosts = [host("dev-2", "Studio", { claudeCode: { found: true } })];
    const devices = await refreshLocalAgentDevices();
    expect(devices.map((d) => d.id)).toEqual(["bridge", "dev-2"]);
    expect(devices[0]?.machineName).toBe("Matthew's Mac");
  });

  test("an older desktop with no /detect identity dedupes nothing", async () => {
    // Nothing to correlate against ⇒ every host stays its own row. Losing the
    // collapse is the safe direction; silently hiding a machine is not.
    paired();
    world.deviceId = null;
    world.hosts = [host("dev-self", "Matthew's Mac")];
    const devices = await refreshLocalAgentDevices();
    expect(devices.map((d) => d.id)).toEqual(["bridge", "dev-self"]);
    expect(devices[0]?.machineName).toBeUndefined();
  });

  test("an AVAILABLE but UNPAIRED bridge is not offered as a device", async () => {
    // Reachable on loopback — but pairing raises a consent modal, so it belongs
    // to the connect affordance, not to the silent device picker.
    expect(await checkDesktopAvailable()).toBe(true);
    expect(getLocalAgentStatus().bridgeAvailable).toBe(true);
    expect(getLocalAgentStatus().bridgePaired).toBe(false);
    expect(listLocalAgentDevices()).toEqual([]);
  });

  test("relay hosts alone, with capabilities mapped from the listing", async () => {
    world.bridgeUp = false;
    world.hosts = [
      host("dev-1", "Studio", { claudeCode: { found: true }, cursor: { found: false } }),
      host("dev-2", "", { cursor: { found: true } }),
    ];
    const devices = await refreshLocalAgentDevices();
    expect(devices).toEqual([
      {
        id: "dev-1",
        kind: "relay",
        name: "Studio",
        online: true,
        capabilities: { claudeCode: true, cursor: false },
        pref: { kind: "relay", deviceId: "dev-1" },
      },
      {
        id: "dev-2",
        // A nameless host still needs a label — fall back to its id.
        name: "dev-2",
        kind: "relay",
        online: true,
        capabilities: { claudeCode: false, cursor: true },
        pref: { kind: "relay", deviceId: "dev-2" },
      },
    ]);
  });

  test("bridge first, then hosts in listing order — the order `auto` resolves in", async () => {
    paired();
    world.hosts = [host("dev-1", "Studio"), host("dev-2", "Laptop")];
    const devices = await refreshLocalAgentDevices();
    expect(devices.map((d) => d.id)).toEqual(["bridge", "dev-1", "dev-2"]);
    // The first entry is what the active source would have picked.
    expect(await resolveLocalAgentSource()).toEqual({ kind: "bridge" });
  });

  test("derives from an explicit snapshot without consulting the live state", () => {
    const devices = listLocalAgentDevices({
      ...getLocalAgentStatus(),
      bridgeAvailable: true,
      bridgePaired: true,
      relayHosts: [],
    });
    expect(devices.map((d) => d.id)).toEqual(["bridge"]);
    // The live state is still untouched.
    expect(listLocalAgentDevices()).toEqual([]);
  });
});

describe("resolveSourceFor", () => {
  test("resolves a specific device without becoming the active selection", async () => {
    paired();
    world.hosts = [host("dev-1", "Studio")];

    const resolved = await resolveSourceFor({ kind: "relay", deviceId: "dev-1" });
    expect(resolved).toEqual({ kind: "relay", deviceId: "dev-1", deviceName: "Studio" });

    // None of the selection fields moved: `pref` is still the user's default,
    // and nothing has been declared connected yet.
    const status = getLocalAgentStatus();
    expect(status.pref).toEqual({ kind: "auto" });
    expect(status.source).toBeNull();
    expect(status.connected).toBe(false);
    // The informational half IS allowed to update — those are facts, not a choice.
    expect(status.relayHosts.map((h) => h.deviceId)).toEqual(["dev-1"]);
  });

  test("does not poison the memo a later resolveLocalAgentSource() uses", async () => {
    paired();
    world.hosts = [host("dev-1", "Studio")];
    await resolveSourceFor({ kind: "relay", deviceId: "dev-1" });

    // Auto still walks bridge-first, exactly as if the override had not happened.
    expect(await resolveLocalAgentSource()).toEqual({ kind: "bridge" });
    expect(getLocalAgentStatus().connected).toBe(true);
    expect(getLocalAgentStatus().source).toEqual({ kind: "bridge" });
  });

  test("an unresolvable device answers null, still without touching the selection", async () => {
    paired();
    await resolveLocalAgentSource();
    // No token would be usable for an unpaired bridge — but the ACTIVE source
    // (a paired bridge) stays connected regardless.
    localStorage.removeItem("unified.agentBridge.token");
    expect(await resolveSourceFor({ kind: "bridge" })).toBeNull();
    expect(getLocalAgentStatus().connected).toBe(true);
    expect(getLocalAgentStatus().source).toEqual({ kind: "bridge" });
  });
});

describe("per-call source overrides", () => {
  test("detectAgents reaches a DIFFERENT device than the active source", async () => {
    paired();
    world.hosts = [host("dev-1", "Studio", { cursor: { found: true } })];
    expect(await resolveLocalAgentSource()).toEqual({ kind: "bridge" });

    // Omitted: the active source (the bridge, which has Claude Code only).
    expect(await detectAgents()).toEqual({
      claudeCode: { found: true, path: "/usr/local/bin/claude" },
      cursor: { found: false, path: null },
    });

    // Overridden: the relay host, whose advertised capabilities are the mirror
    // image — and which is read from the LISTING, so no socket is opened.
    expect(await detectAgents({ kind: "relay", deviceId: "dev-1" })).toEqual({
      claudeCode: { found: false, path: null },
      cursor: { found: true, path: null },
    });
    expect(FakeSocket.last).toBeNull();

    // The override left the active source alone.
    expect(getLocalAgentStatus().source).toEqual({ kind: "bridge" });
  });

  test("listLocalModels answers per device, without one roster leaking into the other", async () => {
    paired();
    world.hosts = [
      host("dev-1", "Studio", { claudeCode: { found: false }, cursor: { found: false } }),
    ];
    await resolveLocalAgentSource();

    const local = await listLocalModels();
    expect(local.map((m) => m.id)).toEqual([
      "claude-code/opus",
      "claude-code/sonnet",
      "claude-code/haiku",
      "claude-code/fable",
    ]);
    // The relay host advertises neither CLI, so its catalog is empty — the
    // bridge's entries must not be handed out for it.
    expect(await listLocalModels({ kind: "relay", deviceId: "dev-1" })).toEqual([]);
  });

  test("startAgentRun routes to the overridden device, and to the active one when omitted", async () => {
    paired();
    world.hosts = [host("dev-1", "Studio")];
    await resolveLocalAgentSource();

    // Omitted → the bridge: the run is POSTed over loopback.
    await startAgentRun("claude-code", RUN_ARGS, NO_HANDLERS);
    expect(world.calls.some((c) => c.url.endsWith("/runs"))).toBe(true);
    expect(FakeSocket.last).toBeNull();

    // Overridden → the relay host: a socket to THAT device is opened, and
    // nothing more goes over loopback. (The socket never completes its
    // handshake here, so the start frame parks — the routing is the assertion.)
    const started = startAgentRun("claude-code", { ...RUN_ARGS, runId: "run-2" }, NO_HANDLERS, {
      kind: "relay",
      deviceId: "dev-1",
    });
    started.catch(() => {});
    await flush();
    expect(FakeSocket.last?.url).toStartWith("ws://api.test/api/v1/relay/connect/dev-1");
    expect(world.calls.filter((c) => c.url.endsWith("/runs"))).toHaveLength(1);
  });
});
