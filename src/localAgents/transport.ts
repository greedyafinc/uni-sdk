// The single switch behind the local-agent CLI lanes, for SDK consumers.
//
// Claude Code and Cursor can be driven from two places outside the desktop
// webview itself:
//
//   bridge — a browser talking to a UnifiedApp desktop on the SAME machine over
//            the loopback HTTP+SSE bridge (agent-bridge.md).
//   relay  — any signed-in surface talking to one of the user's machines
//            through unified-api's WebSocket relay (agent-relay.md).
//
// (The desktop webview's own third source, Tauri IPC, has no meaning here: an
// SDK consumer is by definition not the shell.)
//
// Both carry the CLIs' RAW NDJSON lines, so the ported translators and the
// session-continuity logic are identical either way. Model ids stay
// `claude-code/*` and `cursor/*` on every source so conversations stay portable.
//
// CONSENT DISCIPLINE — the rule this module exists to enforce: resolving a
// source must never *create* trust, only RESTORE it. The desktop owns the
// approval (its origin set is on disk); the browser's token is a cached
// credential that can go missing, so resolving asks the desktop for a fresh one
// with a silent pair — which re-mints for an approved origin and is refused with
// 403, no modal, for anyone else. Relay hosts likewise only ever come from the
// ordinary `GET /hosts` listing under the caller's own credentials.
//
// First-time approval is `connectDesktop()`, called from an explicit user
// action, and it is the ONLY path here that can raise a modal.
import { Observable } from "../core/_internal/observable";
import type { McpCallResult, McpToolDef } from "./_internal/toolServer";
import {
  type BridgeEventStream,
  bridgeCursorModels,
  bridgeDetect,
  bridgeMcpResult,
  bridgePickFolder,
  bridgeStartRun,
  bridgeStopRun,
  clearBridgeToken,
  defaultPairName,
  discoverBridge,
  hasBridgeToken,
  ensureBridgeToken,
  invalidateBridgePort,
  openRunEvents,
  pairBridge,
} from "./bridgeClient";
import {
  type RelayHost,
  closeAllRelayHosts,
  connectRelayHost,
  listRelayHosts,
} from "./relayClient";

export type Lane = "claude-code" | "cursor";
export type LocalAgentSourceKind = "bridge" | "relay";

/** What the caller asked for. `auto` walks bridge → first online relay host. */
export type LocalAgentSourcePref =
  | { kind: "auto" }
  | { kind: "bridge" }
  | { kind: "relay"; deviceId: string };

/** What we actually resolved to. `null` = nothing can run a local agent here. */
export interface LocalAgentSource {
  kind: LocalAgentSourceKind;
  /** Relay only. */
  deviceId?: string;
  deviceName?: string;
}

/**
 * One selectable compute device, derived from a status snapshot — the row a
 * device dropdown renders. `pref` is what to hand back to the per-call `source`
 * overrides, so a UI never has to rebuild the discriminated union itself.
 */
export interface LocalAgentDevice {
  /** Stable id: "bridge" for the loopback desktop, else the relay deviceId. */
  id: string;
  kind: LocalAgentSourceKind;
  name: string;
  online: boolean;
  /**
   * The machine's OWN name, when the row's label does not already carry it —
   * i.e. on the collapsed local row, whose label is "This computer". A UI shows
   * it as secondary text so collapsing two transports loses no information.
   */
  machineName?: string;
  /** Advertised CLIs. Absent when no transport for this machine reported any. */
  capabilities?: { claudeCode: boolean; cursor: boolean };
  /** Pass this to the per-call `source` overrides below. */
  pref: LocalAgentSourcePref;
}

export interface LocalAgentDetectResult {
  claudeCode: { found: boolean; path: string | null };
  cursor: { found: boolean; path: string | null };
}

export interface LocalAgentStatus {
  /** True once a source has resolved — i.e. a desktop is reachable and usable. */
  connected: boolean;
  source: LocalAgentSource | null;
  pref: LocalAgentSourcePref;
  /** null = the loopback range has not been probed yet. */
  bridgeAvailable: boolean | null;
  /** Whether this origin holds a bridge pairing token. False ⇒ pairing is needed. */
  bridgePaired: boolean;
  /**
   * The bridged desktop's relay `deviceId` / name / CLIs, from the authenticated
   * `GET /detect` (agent-bridge.md). This is what tells us which relay host in
   * `relayHosts` IS the machine on the other end of the loopback bridge, so the
   * device listing can collapse the two into one row. All null until a paired
   * bridge has answered.
   */
  bridgeDeviceId: string | null;
  bridgeDeviceName: string | null;
  bridgeCapabilities: { claudeCode: boolean; cursor: boolean } | null;
  relayHosts: RelayHost[];
  resolving: boolean;
  lastError: string | null;
}

const PREF_KEY = "unified.agentCompute.source";

// ── Observable state ────────────────────────────────────────────────────────

function initialStatus(): LocalAgentStatus {
  return {
    connected: false,
    source: null,
    pref: loadPref(),
    bridgeAvailable: null,
    bridgePaired: hasBridgeToken(),
    bridgeDeviceId: null,
    bridgeDeviceName: null,
    bridgeCapabilities: null,
    relayHosts: [],
    resolving: false,
    lastError: null,
  };
}

const status = new Observable<LocalAgentStatus>(initialStatus());

function patch(next: Partial<LocalAgentStatus>): void {
  status.set({ ...status.get(), ...next });
}

/** The current status, synchronously. Never throws. */
export function getLocalAgentStatus(): LocalAgentStatus {
  return status.get();
}

/** Subscribe to status changes; returns an unsubscribe. */
export function onLocalAgentStatusChange(listener: (status: LocalAgentStatus) => void): () => void {
  return status.subscribe(listener);
}

/**
 * Whether a desktop source is connected RIGHT NOW, synchronously — the answer
 * `hasRunAgent()` needs. False until `resolveLocalAgentSource()` has settled,
 * so a host that wants it true at first paint should await that once at startup.
 */
export function isDesktopConnected(): boolean {
  return status.get().connected;
}

function loadPref(): LocalAgentSourcePref {
  try {
    const raw = globalThis.localStorage?.getItem(PREF_KEY) ?? null;
    if (!raw) return { kind: "auto" };
    const parsed = JSON.parse(raw) as LocalAgentSourcePref;
    if (parsed?.kind === "relay" && typeof parsed.deviceId === "string") return parsed;
    if (parsed?.kind === "bridge" || parsed?.kind === "auto") return { kind: parsed.kind };
  } catch {
    // fall through
  }
  return { kind: "auto" };
}

function savePref(pref: LocalAgentSourcePref): void {
  try {
    if (pref.kind === "auto") globalThis.localStorage?.removeItem(PREF_KEY);
    else globalThis.localStorage?.setItem(PREF_KEY, JSON.stringify(pref));
  } catch {
    // fail-soft — the choice just doesn't survive a reload
  }
}

// ── Source resolution ───────────────────────────────────────────────────────

let resolvePromise: Promise<LocalAgentSource | null> | null = null;

/**
 * The active source, resolved once per page session (or until
 * `setLocalAgentSource` / `refreshLocalAgents` invalidates it).
 *
 * Safe to call on page load: it probes the unauthenticated `/health` endpoint
 * and lists relay hosts, neither of which raises a prompt anywhere.
 */
export function resolveLocalAgentSource(): Promise<LocalAgentSource | null> {
  if (!resolvePromise) {
    patch({ resolving: true });
    resolvePromise = resolveSourceFor(status.get().pref).then(
      (source) => {
        patch({ source, connected: source !== null, resolving: false });
        return source;
      },
      (err) => {
        patch({
          source: null,
          connected: false,
          resolving: false,
          lastError: err instanceof Error ? err.message : String(err),
        });
        return null;
      },
    );
  }
  return resolvePromise;
}

export function setLocalAgentSource(pref: LocalAgentSourcePref): Promise<LocalAgentSource | null> {
  patch({ pref });
  savePref(pref);
  // A switch away from relay drops the sockets: a source we are not using has no
  // business holding an open connection to somebody's laptop.
  if (pref.kind !== "relay") closeAllRelayHosts();
  return refreshLocalAgents();
}

/** Re-probe the bridge and re-list relay hosts, then re-resolve. */
export function refreshLocalAgents(): Promise<LocalAgentSource | null> {
  resolvePromise = null;
  invalidateBridgePort();
  adoptRefused = false;
  return resolveLocalAgentSource();
}

/**
 * Resolve ONE specific preference, without touching the active selection.
 *
 * This is the per-surface half of source selection: a chat pane that wants to
 * run on a particular machine resolves that machine here, while the global
 * `pref` / `source` / `connected` fields keep describing whatever the user
 * chose as their default. Only the informational fields (`bridgeAvailable`,
 * `relayHosts`) are patched — those are facts about the world, not a selection
 * — and the memoized `resolveLocalAgentSource()` promise is never written.
 *
 * Prompt-free by the same rules as auto-select: it probes `/health` and reads
 * the `GET /hosts` listing, and never pairs.
 */
export async function resolveSourceFor(
  pref: LocalAgentSourcePref,
): Promise<LocalAgentSource | null> {
  if (pref.kind === "bridge") {
    return (await bridgeUsable()) ? { kind: "bridge" } : null;
  }

  if (pref.kind === "relay") {
    const hosts = await refreshRelayHosts();
    const host = hosts.find((h) => h.deviceId === pref.deviceId);
    // An explicitly chosen host that is momentarily offline stays chosen — the
    // connection retries with backoff rather than silently demoting the user's
    // pick to some other machine.
    return {
      kind: "relay",
      deviceId: pref.deviceId,
      deviceName: host?.deviceName ?? pref.deviceId,
    };
  }

  // auto
  if (await bridgeUsable()) return { kind: "bridge" };
  const hosts = await refreshRelayHosts();
  const first = hosts[0];
  if (first) return { kind: "relay", deviceId: first.deviceId, deviceName: first.deviceName };
  return null;
}

async function probeBridge(): Promise<boolean> {
  const port = await discoverBridge();
  patch({ bridgeAvailable: port !== null });
  if (port === null) return false;
  if (hasBridgeToken()) await refreshBridgeIdentity();
  return true;
}

/**
 * Is a desktop reachable AND usable from here? Availability plus a credential,
 * restoring the credential from the desktop's own approval when we have none.
 *
 * The two halves are separate on purpose: `probeBridge` answers "is anything
 * there", which several callers want without side effects, and this is the one
 * that may mint. Folding the adopt into the probe made an invisible effect
 * load-bearing for correctness — whether a caller ended up with a token then
 * depended on which helper it happened to reach for.
 */
async function bridgeUsable(): Promise<boolean> {
  if (!(await probeBridge())) return false;
  if (!hasBridgeToken()) {
    await adoptApprovedOrigin();
    if (hasBridgeToken()) await refreshBridgeIdentity();
  }
  return hasBridgeToken();
}

/**
 * Ask the DESKTOP whether this origin is approved, and take a token if it is.
 * A silent pair IS that question — see the consent discipline at the top of this
 * file. Safe on a page-load path: it can restore a connection, never create one.
 */
let adoptRefused = false;
async function adoptApprovedOrigin(): Promise<void> {
  // A refusal is stable for this page: the desktop will keep saying no until the
  // user approves this origin, which only happens through `connectDesktop`. Left
  // un-remembered, every resolve — and there is one per surface — repeats the
  // forced port scan and the 403.
  if (hasBridgeToken() || adoptRefused) return;
  try {
    await ensureBridgeToken();
    patch({ bridgePaired: true, lastError: null });
  } catch {
    adoptRefused = true;
  }
}

/**
 * Learn which machine the loopback bridge belongs to.
 *
 * Prompt-free: `/detect` is bearer-authenticated, and we only call it when a
 * token already exists — a previously approved origin re-mints silently, so no
 * consent modal can appear. Failure is not an error, just "we don't know", which
 * costs nothing but the de-duplication.
 */
async function refreshBridgeIdentity(): Promise<void> {
  try {
    const detected = await bridgeDetect();
    patch({
      bridgeDeviceId: typeof detected.deviceId === "string" ? detected.deviceId : null,
      bridgeDeviceName: typeof detected.deviceName === "string" ? detected.deviceName : null,
      bridgeCapabilities: {
        claudeCode: detected.claudeCode?.found === true,
        cursor: detected.cursor?.found === true,
      },
    });
  } catch {
    patch({ bridgeDeviceId: null, bridgeDeviceName: null, bridgeCapabilities: null });
  }
}

/**
 * Is a UnifiedApp desktop listening on loopback? Safe to call unprompted —
 * `/health` is unauthenticated and raises no consent modal. Use it to decide
 * whether to OFFER a "Connect to desktop" affordance.
 */
export async function checkDesktopAvailable(): Promise<boolean> {
  invalidateBridgePort();
  return await probeBridge();
}

/**
 * User-initiated pairing. For a NEW origin this PARKS on a consent modal on the
 * desktop (120s, then 403), so it must never be reached from a page-load code
 * path — call it only from an explicit user action.
 *
 * When this origin already holds a token it re-mints SILENTLY instead. The token
 * lives in localStorage and the desktop's approval is on disk, so pairing
 * survives a page refresh; asking the user to approve the same origin again on
 * every reload is a prompt for a decision they already made. If the desktop
 * revoked us meanwhile the silent attempt 403s — that is the one case where a
 * fresh modal is the right answer, so we drop the dead token and ask properly.
 */
export async function connectDesktop(name?: string): Promise<LocalAgentSource | null> {
  const label = name ?? defaultPairName();
  try {
    // Silent only when we already hold a token — that is the case where the user
    // has answered this question before.
    await pairBridge(label, hasBridgeToken());
  } catch (err) {
    // No token means that WAS the first-time attempt, and its failure is the
    // user's answer (declined, timed out, no desktop) — not something to retry.
    if (!hasBridgeToken()) throw err;
    // The desktop revoked us while we held a stale token: drop it and ask properly.
    clearBridgeToken();
    await pairBridge(label);
  }
  adoptRefused = false;
  patch({ bridgePaired: true, bridgeAvailable: true, lastError: null });
  return await setLocalAgentSource({ kind: "bridge" });
}

/** Forget the pairing token. The desktop keeps its origin approval. */
export async function disconnectDesktop(): Promise<void> {
  clearBridgeToken();
  adoptRefused = false;
  patch({ bridgePaired: false });
  if (status.get().pref.kind === "bridge") await setLocalAgentSource({ kind: "auto" });
  else await refreshLocalAgents();
}

/** List the account's online relay hosts. A plain GET — not a connection. */
export async function refreshRelayHosts(): Promise<RelayHost[]> {
  try {
    const hosts = await listRelayHosts();
    patch({ relayHosts: hosts });
    return hosts;
  } catch {
    // Signed out, offline, or relay module absent — all "no hosts" as far as
    // source selection is concerned.
    patch({ relayHosts: [] });
    return [];
  }
}

// ── Device listing ──────────────────────────────────────────────────────────

/**
 * The devices a caller may pick from, derived from a status snapshot. Pure and
 * synchronous — it reads what the last probe/listing already established, so a
 * dropdown can render it on every status change without any I/O.
 *
 * ONE ROW PER PHYSICAL MACHINE. The bridge and the relay are two roads to the
 * same computer, and a user picking where their code runs is picking a machine,
 * not a wire. So when the paired bridge's `/detect` identity matches a relay
 * host in the listing, the two collapse into a single "This computer" row whose
 * `pref` is the BEST transport available for that machine (bridge beats relay:
 * loopback is faster and does not leave the box), with the machine's own name
 * carried in `machineName` and the CLIs merged from both reports.
 *
 * Without a bridge identity there is nothing to correlate against, so every
 * relay host is genuinely a different machine and nothing collapses — which is
 * correct: a browser with no bridge cannot be co-located with any host.
 *
 * Order is LOCAL FIRST, then the relay hosts in listing order, which is exactly
 * what `{ kind: "auto" }` resolves to — so a UI that defaults to the first entry
 * defaults to the same machine the active source would use.
 *
 * The bridge appears only when it is both reachable AND already paired: an
 * unpaired desktop is `connectDesktop()`'s business (it raises a consent modal),
 * not a silently selectable device.
 */
export function listLocalAgentDevices(snapshot?: LocalAgentStatus): LocalAgentDevice[] {
  const s = snapshot ?? getLocalAgentStatus();
  const devices: LocalAgentDevice[] = [];
  const bridged = s.bridgeAvailable === true && s.bridgePaired === true;
  // The relay host that IS this bridged machine, if it is also sharing itself.
  const selfHost = bridged && s.bridgeDeviceId
    ? (s.relayHosts.find((h) => h.deviceId === s.bridgeDeviceId) ?? null)
    : null;

  if (bridged) {
    const merged = mergeCaps(s.bridgeCapabilities, hostCaps(selfHost));
    devices.push({
      id: "bridge",
      kind: "bridge",
      name: "This computer",
      online: true,
      ...(s.bridgeDeviceName || selfHost?.deviceName
        ? { machineName: s.bridgeDeviceName || (selfHost?.deviceName as string) }
        : {}),
      ...(merged ? { capabilities: merged } : {}),
      // Best available transport for this machine: the loopback bridge, even
      // when the same box is also reachable the long way round via the relay.
      pref: { kind: "bridge" },
    });
  }

  for (const host of s.relayHosts) {
    // Already represented by the collapsed local row above.
    if (selfHost && host.deviceId === selfHost.deviceId) continue;
    devices.push({
      id: host.deviceId,
      kind: "relay",
      name: host.deviceName || host.deviceId,
      // The listing only ever returns hosts that are currently connected.
      online: true,
      capabilities: hostCaps(host) ?? { claudeCode: false, cursor: false },
      pref: { kind: "relay", deviceId: host.deviceId },
    });
  }
  return devices;
}

function hostCaps(host: RelayHost | null): { claudeCode: boolean; cursor: boolean } | null {
  if (!host) return null;
  return {
    claudeCode: host.capabilities?.claudeCode?.found === true,
    cursor: host.capabilities?.cursor?.found === true,
  };
}

/** A CLI is present on the machine if ANY transport to it reported it. */
function mergeCaps(
  a: { claudeCode: boolean; cursor: boolean } | null,
  b: { claudeCode: boolean; cursor: boolean } | null,
): { claudeCode: boolean; cursor: boolean } | null {
  if (!a) return b;
  if (!b) return a;
  return { claudeCode: a.claudeCode || b.claudeCode, cursor: a.cursor || b.cursor };
}

/**
 * Re-probe the loopback bridge and re-list the relay hosts, then derive the
 * device list. Prompt-free, and it does NOT change the active source or the
 * saved preference — use `setLocalAgentSource()` for that.
 */
export async function refreshLocalAgentDevices(): Promise<LocalAgentDevice[]> {
  invalidateBridgePort();
  adoptRefused = false;
  patch({ bridgePaired: hasBridgeToken() });
  // `bridgeUsable`, not `probeBridge`: a device listing is exactly where a
  // desktop that approved this origin should reappear without the user asking.
  await Promise.all([bridgeUsable(), refreshRelayHosts()]);
  return listLocalAgentDevices();
}

// ── Capability surface ──────────────────────────────────────────────────────

const NOT_FOUND: LocalAgentDetectResult = {
  claudeCode: { found: false, path: null },
  cursor: { found: false, path: null },
};

/**
 * The source one call should use: a specific device when `pref` is given,
 * otherwise the memoized active source. Omitting `pref` is exactly the old
 * behavior, memo and all.
 */
function sourceFor(pref?: LocalAgentSourcePref): Promise<LocalAgentSource | null> {
  return pref ? resolveSourceFor(pref) : resolveLocalAgentSource();
}

/** Which CLIs a source can run — the active one, or `pref`'s device. */
export async function detectAgents(pref?: LocalAgentSourcePref): Promise<LocalAgentDetectResult> {
  const source = await sourceFor(pref);
  if (!source) return NOT_FOUND;
  if (source.kind === "bridge") {
    try {
      // Narrowed to the CLI halves: `/detect` also carries the machine identity,
      // which belongs to device LISTING, not to a capability answer.
      const { claudeCode, cursor } = await bridgeDetect();
      return { claudeCode, cursor };
    } catch {
      return NOT_FOUND;
    }
  }
  // Relay: the host's advertised capabilities, from the LISTING. Deliberately
  // not a `detect` frame — building a model catalog must not require the host
  // to have approved this device yet (that would be a consent prompt raised by
  // a page merely rendering a model picker).
  const host = status.get().relayHosts.find((h) => h.deviceId === source.deviceId);
  if (!host) return NOT_FOUND;
  return {
    claudeCode: { found: host.capabilities?.claudeCode?.found === true, path: null },
    cursor: { found: host.capabilities?.cursor?.found === true, path: null },
  };
}

export interface CursorModelsOutput {
  ok: boolean;
  output: string;
}

/** `cursor-agent models` output from the active source, or `pref`'s device. */
export async function cursorModelsOutput(
  json: boolean,
  pref?: LocalAgentSourcePref,
): Promise<CursorModelsOutput> {
  const source = await sourceFor(pref);
  if (!source) return { ok: false, output: "" };
  try {
    if (source.kind === "bridge") {
      const output = await bridgeCursorModels(json);
      return { ok: !!output.trim(), output };
    }
    const output = await connectRelayHost(source.deviceId as string).cursorModels(json);
    return { ok: !!output.trim(), output };
  } catch {
    return { ok: false, output: "" };
  }
}

/**
 * Open the native folder picker on the machine the source runs on (the active
 * one, or `pref`'s device — the folder belongs to whichever machine will run
 * the work, so the picker must open THERE). The
 * paths belong to THAT machine, which is exactly why the dialog opens there —
 * and per both contracts, the user picking a folder in that dialog is also the
 * host-side read consent for it.
 *
 * Returns null when the user cancelled or no source is connected.
 */
export async function pickWorkspaceFolder(pref?: LocalAgentSourcePref): Promise<string | null> {
  const source = await sourceFor(pref);
  if (!source) return null;
  if (source.kind === "bridge") return await bridgePickFolder();
  return await connectRelayHost(source.deviceId as string).pickFolder();
}

// ── Runs ────────────────────────────────────────────────────────────────────

export interface StartArgs {
  runId: string;
  prompt: string;
  model: string | null;
  /** Claude Code only. */
  effort?: string | null;
  /**
   * The calling app's system instructions, delivered as a REAL system prompt.
   * Claude Code only — Cursor's CLI has no equivalent flag, so that lane folds
   * them into `prompt` instead and leaves this unset.
   */
  systemPrompt?: string | null;
  resume?: string | null;
  workspace?: string | null;
  trustWorkspace?: boolean;
  extraDirs?: string[];
  /** Serve the caller's tools to this run over MCP. */
  mcp: boolean;
}

export interface RunHandlers {
  onLine(line: string): void;
  onExit(exit: { code: number | null; canceled: boolean; stderr: string }): void;
  /** Answer the CLI's `tools/list`. */
  onMcpList(): McpToolDef[];
  /** Answer the CLI's `tools/call`. */
  onMcpCall(name: string, args: unknown): Promise<McpCallResult>;
}

export interface RunHandle {
  stop(): void;
}

/**
 * Start one CLI run on the active source, or on `pref`'s device when given —
 * which is how two surfaces can run on two different machines at once.
 *
 * Resolves once the run has been ACCEPTED (the child spawned, or the frame
 * sent). Rejects if it could not be started.
 */
export async function startAgentRun(
  lane: Lane,
  args: StartArgs,
  handlers: RunHandlers,
  pref?: LocalAgentSourcePref,
): Promise<RunHandle> {
  const source = await sourceFor(pref);
  if (!source) throw new Error("No computer available to run local coding agents.");
  return source.kind === "bridge"
    ? await startBridgeRun(lane, args, handlers)
    : await startRelayRun(source.deviceId as string, lane, args, handlers);
}

/** The lane-specific half of a start payload; identical on both wires. */
function startPayload(lane: Lane, args: StartArgs) {
  return {
    runId: args.runId,
    prompt: args.prompt,
    model: args.model,
    ...(lane === "claude-code"
      ? { effort: args.effort ?? null, systemPrompt: args.systemPrompt ?? null }
      : {}),
    resume: args.resume ?? null,
    workspace: args.workspace ?? null,
    trustWorkspace: args.trustWorkspace ?? false,
    extraDirs: args.extraDirs ?? [],
    mcp: args.mcp,
  };
}

/** Route an `mcp-list`/`mcp-call` round-trip to the caller's tools and answer it. */
function mcpRouter(handlers: RunHandlers, answer: (id: string, result: unknown) => void) {
  return {
    onMcpList: (id: string) => answer(id, { tools: handlers.onMcpList() }),
    onMcpCall: (id: string, name: string, args: unknown) => {
      void handlers.onMcpCall(name, args).then(
        (result) => answer(id, result),
        (err: unknown) =>
          answer(id, {
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          }),
      );
    },
  };
}

async function startBridgeRun(
  lane: Lane,
  args: StartArgs,
  handlers: RunHandlers,
): Promise<RunHandle> {
  const answer = (id: string, result: unknown) => {
    void bridgeMcpResult(id, result).catch(() => {});
  };
  const mcp = mcpRouter(handlers, answer);

  let stream: BridgeEventStream | null = null;
  let done = false;
  const finish = (exit: { code: number | null; canceled: boolean; stderr: string }) => {
    if (done) return;
    done = true;
    stream?.close();
    handlers.onExit(exit);
  };

  // The contract requires the SSE stream to be attached BEFORE the run starts;
  // the client-generated runId is what makes that possible.
  stream = await openRunEvents(args.runId, {
    onLine: handlers.onLine,
    onExit: finish,
    onMcpList: mcp.onMcpList,
    onMcpCall: mcp.onMcpCall,
    onError: (message) => finish({ code: null, canceled: false, stderr: message }),
  });

  try {
    await bridgeStartRun({ lane, ...startPayload(lane, args) });
  } catch (err) {
    stream.close();
    throw err;
  }

  return {
    stop() {
      void bridgeStopRun(args.runId).catch(() => {});
    },
  };
}

async function startRelayRun(
  deviceId: string,
  lane: Lane,
  args: StartArgs,
  handlers: RunHandlers,
): Promise<RunHandle> {
  const conn = connectRelayHost(deviceId);
  const answer = (id: string, result: unknown) => conn.mcpResult(id, result);
  const mcp = mcpRouter(handlers, answer);

  await conn.startRun(
    { lane, ...startPayload(lane, args) },
    {
      onLine: handlers.onLine,
      onExit: handlers.onExit,
      onMcpList: mcp.onMcpList,
      onMcpCall: mcp.onMcpCall,
    },
  );

  return {
    stop() {
      conn.stopRun(args.runId);
    },
  };
}

/** Test seam: forget the memoized source resolution and reset observable state. */
export function _resetLocalAgentState(): void {
  resolvePromise = null;
  adoptRefused = false;
  invalidateBridgePort();
  closeAllRelayHosts();
  status.set(initialStatus());
}
