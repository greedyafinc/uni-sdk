// Browser client for the UnifiedApp desktop app's loopback **agent bridge**.
//
// Wire contract: UnifiedApp `apps/desktop/docs/agent-bridge.md` (server:
// `src-tauri/src/agent_bridge.rs`). This is a port of the desktop frontend's
// own `src/agentCli/bridgeClient.ts` — the two speak the identical wire, so a
// contract change has to land in all three.
//
// The bridge lets ANY browser page (an external marketplace app running
// standalone on localhost, the web client, …) drive the DESKTOP machine's
// Claude Code / Cursor CLIs. Everything here is plain `fetch` against
// `127.0.0.1:<port>`; the only state kept is the discovered port and the
// pairing token, both in localStorage.
//
// Nothing in this module contacts the bridge on import. Discovery is cheap
// (five small GETs) but PAIRING raises a consent modal on the user's desktop,
// so `pairBridge()` is only ever called from an explicit user action — or
// silently re-issued when a token we already had is rejected (the origin is
// then already approved, so the desktop re-mints without a prompt; see the
// contract's "Pairing" section).
//
// Browser-safe: no `node:` builtins, no keychain, no framework.

// `localAgentsConfig` supplies the DISPLAY name; `unifiedToken` supplies the
// caller's account credential, which is what lets pairing skip the consent
// prompt entirely (see `pairBridge`).
import { localAgentsConfig, unifiedToken } from "./config";
import { type LocalAgentDirListing, normalizeDirListing } from "./dirListing";

/** Ports the desktop server tries, in order (agent-bridge.md § Discovery). */
export const BRIDGE_PORTS = [47825, 47826, 47827, 47828, 47829] as const;

const PORT_KEY = "unified.agentBridge.port";
const TOKEN_KEY = "unified.agentBridge.token";

/** `/health`'s service marker — a random loopback server on 47825 is not us. */
const SERVICE = "unified-agent-bridge";

/** Probing five dead ports must not stall a page; each attempt is capped. */
const PROBE_TIMEOUT_MS = 1200;
/** Ordinary request budget. `pick-folder` is deliberately exempt (it blocks on a dialog). */
const REQUEST_TIMEOUT_MS = 15_000;

export interface BridgeDetectResult {
  claudeCode: { found: boolean; path: string | null };
  cursor: { found: boolean; path: string | null };
  /**
   * This machine's identity — the SAME `deviceId` the desktop registers with on
   * the agent relay, plus the account's name for it. Present only on the
   * AUTHENTICATED `/detect` (never on the unauthenticated `/health`), and null
   * on a desktop that has no auth state yet.
   *
   * Their whole purpose is de-duplication: a browser paired to this desktop can
   * see that a relay host in its `GET /hosts` listing IS the machine on the
   * other end of the loopback bridge, and offer one device row instead of two.
   */
  deviceId?: string | null;
  deviceName?: string | null;
}

export interface BridgeStartBody {
  lane: "claude-code" | "cursor";
  runId: string;
  prompt: string;
  model: string | null;
  effort?: string | null;
  /** Claude Code only; the caller's system instructions. */
  systemPrompt?: string | null;
  resume?: string | null;
  workspace?: string | null;
  trustWorkspace?: boolean;
  extraDirs?: string[];
  mcp: boolean;
}

export interface BridgeRunHandlers {
  onLine(line: string): void;
  onExit(exit: { code: number | null; canceled: boolean; stderr: string }): void;
  onMcpList?(id: string): void;
  onMcpCall?(id: string, name: string, args: unknown): void;
  /** Transport-level failure (stream died before `exit`). */
  onError?(message: string): void;
}

export interface BridgeEventStream {
  close(): void;
}

// ── Local storage helpers (fail-soft: private mode / quota / no DOM) ─────────

function readLocal(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // fail-soft — worst case we re-probe / re-pair next load
  }
}

/** The pairing token from a previous session, if any. */
export function bridgeToken(): string | null {
  return readLocal(TOKEN_KEY);
}

/**
 * Whether this origin has paired before. Source selection uses this as the
 * auto-activation gate: a page that has never paired must not probe its way
 * into raising a consent modal on somebody's desktop at page load.
 */
export function hasBridgeToken(): boolean {
  return !!bridgeToken();
}

/** Forget the token ("Disconnect", or a 401 we could not re-pair through). */
export function clearBridgeToken(): void {
  writeLocal(TOKEN_KEY, null);
}

// ── Discovery ───────────────────────────────────────────────────────────────

let cachedPort: number | null = null;
/** A completed scan that found nothing — see `discoverBridge`. */
let scanFoundNothing = false;

export function bridgeOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function probe(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${bridgeOrigin(port)}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { service?: unknown };
    return body?.service === SERVICE;
  } catch {
    return false;
  }
}

/**
 * Find the running bridge, preferring the port that worked last time.
 * Returns null when no desktop app is listening.
 */
export async function discoverBridge(force = false): Promise<number | null> {
  if (!force && cachedPort !== null) return cachedPort;
  // "Nothing is listening" is an answer worth remembering too. Every port in the
  // range has to time out before we can conclude it, and resolving a source is a
  // per-surface call — so without this, a page with no desktop pays the whole
  // sequential scan again on every resolve. Cleared by `invalidateBridgePort`,
  // which every explicit refresh path already calls, so a desktop launched after
  // the page still gets found.
  if (!force && scanFoundNothing) return null;

  const remembered = Number(readLocal(PORT_KEY));
  const order: number[] = BRIDGE_PORTS.includes(remembered as (typeof BRIDGE_PORTS)[number])
    ? [remembered, ...BRIDGE_PORTS.filter((p) => p !== remembered)]
    : [...BRIDGE_PORTS];

  for (const port of order) {
    if (await probe(port)) {
      cachedPort = port;
      writeLocal(PORT_KEY, String(port));
      return port;
    }
  }
  cachedPort = null;
  scanFoundNothing = true;
  writeLocal(PORT_KEY, null);
  return null;
}

/** Drop both memoized verdicts so the next call re-probes the range. */
export function invalidateBridgePort(): void {
  cachedPort = null;
  scanFoundNothing = false;
}

/** Whether a bridge is reachable at all (no pairing required). */
export async function bridgeHealth(): Promise<{ ok: boolean; port: number | null }> {
  const port = await discoverBridge(true);
  return { ok: port !== null, port };
}

async function requirePort(): Promise<number> {
  const port = await discoverBridge();
  if (port === null) throw new Error("The desktop app isn't running on this machine.");
  return port;
}

// ── Pairing ─────────────────────────────────────────────────────────────────

/**
 * Ask the host for a token for this origin.
 *
 * A caller SIGNED IN AS THE HOST'S OWN USER is let straight through: the
 * account credential travels in `token`, the host resolves it against
 * unified-api, and a match mints without a prompt — silent or not, first time
 * or not. Being signed in as the user IS the permission; asking a second time
 * in a modal only taught people to click Allow.
 *
 * Without a credential there is nothing to check, and the loopback bridge is
 * reachable by any page on the machine — so that case still PARKS on the host's
 * consent prompt (120s, then 403) and must only be reached from an explicit
 * user action. `silent: true` skips the prompt and takes the 403 instead.
 */
export async function pairBridge(name = defaultPairName(), silent = false): Promise<string> {
  const port = await discoverBridge(true);
  if (port === null) throw new Error("The desktop app isn't running on this machine.");
  // Best effort: a signed-out surface simply pairs the old way.
  const account = await unifiedToken();
  const res = await fetch(`${bridgeOrigin(port)}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      ...(silent ? { silent: true } : {}),
      ...(account ? { token: account } : {}),
    }),
  });
  if (res.status === 403) throw new Error("The desktop app declined this connection.");
  if (!res.ok) throw new Error(`Pairing failed (HTTP ${res.status}).`);
  const body = (await res.json()) as { token?: unknown };
  if (typeof body?.token !== "string" || !body.token) throw new Error("Pairing returned no token.");
  writeLocal(TOKEN_KEY, body.token);
  return body.token;
}

/**
 * A human label for the consent modal — the browser's origin is shown by the
 * desktop alongside it. `configureLocalAgents({ clientName })` overrides the
 * generic product name, so a surface the user already recognizes (the web
 * client, a named marketplace app) is named as itself on the card rather than
 * as "some UnifiedAI app".
 */
export function defaultPairName(): string {
  const name = localAgentsConfig().clientName?.trim() || "UnifiedAI app";
  if (typeof location === "undefined") return `${name} (browser)`;
  return `${name} — ${location.host}`;
}

/**
 * Silent (re-)pair — never prompts, so it is safe on a page-load path.
 *
 * It succeeds in two cases: the caller is signed in as the host's user, or the
 * origin was approved by hand once before. Either way the host answers without
 * bothering anybody, and a refusal surfaces as a normal error rather than a
 * surprise modal.
 */
let reauthorizing: Promise<string> | null = null;
export function ensureBridgeToken(): Promise<string> {
  if (!reauthorizing) {
    reauthorizing = pairBridge(defaultPairName(), true).finally(() => {
      reauthorizing = null;
    });
  }
  return reauthorizing;
}

// ── Authenticated requests ──────────────────────────────────────────────────

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Omit the timeout — used by `pick-folder`, which blocks on a native dialog. */
  noTimeout?: boolean;
}

async function send(path: string, opts: RequestOptions, token: string): Promise<Response> {
  const port = await requirePort();
  return await fetch(`${bridgeOrigin(port)}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.noTimeout ? {} : { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
  });
}

/**
 * One authenticated round-trip, retried once through a silent re-pair when the
 * desktop restarted (tokens are in-memory server-side, so a restart 401s every
 * client that was paired before it).
 */
async function authed(path: string, opts: RequestOptions = {}): Promise<Response> {
  const token = bridgeToken();
  if (!token) throw new Error("Not connected to the desktop app.");
  let res: Response;
  try {
    res = await send(path, opts, token);
  } catch {
    // Network-level failure (fetch itself rejected, not an HTTP status): the
    // cached port may be stale — e.g. the desktop restarted on a different
    // port. Re-probe the range once and retry once; do not loop.
    invalidateBridgePort();
    await discoverBridge(true);
    res = await send(path, opts, token);
  }
  if (res.status === 401) {
    const fresh = await ensureBridgeToken();
    res = await send(path, opts, fresh);
  }
  if (!res.ok) throw new Error(`Agent bridge request failed (HTTP ${res.status}).`);
  return res;
}

async function authedJson<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await authed(path, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

// ── Endpoints ───────────────────────────────────────────────────────────────

export function bridgeDetect(): Promise<BridgeDetectResult> {
  return authedJson<BridgeDetectResult>("/detect");
}

export async function bridgeCursorModels(json: boolean): Promise<string> {
  const body = await authedJson<{ output?: string }>(
    `/cursor/models?format=${json ? "json" : "text"}`,
  );
  return body?.output ?? "";
}

export async function bridgeStartRun(body: BridgeStartBody): Promise<void> {
  await authed("/runs", { method: "POST", body });
}

export async function bridgeStopRun(runId: string): Promise<void> {
  await authed(`/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", body: {} });
}

export async function bridgeMcpResult(id: string, result: unknown): Promise<void> {
  await authed("/mcp/result", { method: "POST", body: { id, result } });
}

/** List a directory on the desktop's machine (omit `path` for the default root). */
export async function bridgeListDir(path?: string): Promise<LocalAgentDirListing> {
  const body = await authedJson<unknown>("/list-dir", {
    method: "POST",
    body: path !== undefined ? { path } : {},
  });
  return normalizeDirListing(body);
}

/** Opens the desktop's native folder dialog. Long request; one at a time. */
export async function bridgePickFolder(): Promise<string | null> {
  const body = await authedJson<{ path?: string | null }>("/pick-folder", {
    method: "POST",
    body: {},
    noTimeout: true,
  });
  return body?.path ?? null;
}

// ── Run event stream ────────────────────────────────────────────────────────

/**
 * SSE over `fetch`, not `EventSource`.
 *
 * `EventSource` cannot set an `Authorization` header, and the contract makes
 * every endpoint but `/health` bearer-authenticated. The alternatives were a
 * token in the query string (leaks into logs/history and would have to be a
 * documented exception to the bearer rule) or reading the stream ourselves —
 * which is what this does. The wire format is unchanged: named SSE events with
 * JSON `data`, exactly as the contract specifies.
 *
 * Resolves once the response HEADERS are in, so the caller can `await` this and
 * then `POST /runs` with the stream provably attached (agent-bridge.md: "Clients
 * must open the SSE stream before POST /runs").
 */
export async function openRunEvents(
  runId: string,
  handlers: BridgeRunHandlers,
): Promise<BridgeEventStream> {
  const controller = new AbortController();
  const token = bridgeToken();
  if (!token) throw new Error("Not connected to the desktop app.");
  const port = await requirePort();

  const attach = async (bearer: string): Promise<Response> =>
    await fetch(`${bridgeOrigin(port)}/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Authorization: `Bearer ${bearer}`, Accept: "text/event-stream" },
      signal: controller.signal,
    });

  let res = await attach(token);
  if (res.status === 401) res = await attach(await ensureBridgeToken());
  if (!res.ok || !res.body) {
    controller.abort();
    throw new Error(`Could not open the run stream (HTTP ${res.status}).`);
  }

  void pump(res.body, handlers, controller.signal);
  return { close: () => controller.abort() };
}

async function pump(
  body: ReadableStream<Uint8Array>,
  handlers: BridgeRunHandlers,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawExit = false;
  const trackingHandlers: BridgeRunHandlers = {
    ...handlers,
    onExit: (exit) => {
      sawExit = true;
      handlers.onExit(exit);
    },
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; tolerate CRLF.
      let split: number;
      while ((split = indexOfFrameEnd(buffer)) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split).replace(/^(\r?\n){2}/, "");
        dispatchFrame(frame, trackingHandlers);
      }
    }
    if (!sawExit && !signal.aborted) {
      handlers.onError?.("Agent bridge stream ended before the run finished");
    }
  } catch (err) {
    if (!signal.aborted) {
      handlers.onError?.(err instanceof Error ? err.message : String(err));
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function indexOfFrameEnd(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** Parse one `event:`/`data:` frame and route it. Exported for tests. */
export function dispatchFrame(frame: string, handlers: BridgeRunHandlers): void {
  let name = "message";
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (rawLine.startsWith(":")) continue; // comment / keep-alive
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    const value = colon === -1 ? "" : rawLine.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") dataLines.push(value);
  }
  if (!dataLines.length) return;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
  } catch {
    return;
  }
  switch (name) {
    case "line":
      if (typeof data.line === "string") handlers.onLine(data.line);
      break;
    case "exit":
      handlers.onExit({
        code: typeof data.code === "number" ? data.code : null,
        canceled: data.canceled === true,
        stderr: typeof data.stderr === "string" ? data.stderr : "",
      });
      break;
    case "mcp-list":
      if (typeof data.id === "string") handlers.onMcpList?.(data.id);
      break;
    case "mcp-call":
      if (typeof data.id === "string" && typeof data.name === "string") {
        handlers.onMcpCall?.(data.id, data.name, data.arguments);
      }
      break;
  }
}
