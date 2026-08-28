import type { McpCallResult, McpToolDef } from "./_internal/toolServer.js";
import { type RelayHost } from "./relayClient.js";
export type Lane = "claude-code" | "cursor";
export type LocalAgentSourceKind = "bridge" | "relay";
/** What the caller asked for. `auto` walks bridge → first online relay host. */
export type LocalAgentSourcePref = {
    kind: "auto";
} | {
    kind: "bridge";
} | {
    kind: "relay";
    deviceId: string;
};
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
    capabilities?: {
        claudeCode: boolean;
        cursor: boolean;
    };
    /** Pass this to the per-call `source` overrides below. */
    pref: LocalAgentSourcePref;
}
export interface LocalAgentDetectResult {
    claudeCode: {
        found: boolean;
        path: string | null;
    };
    cursor: {
        found: boolean;
        path: string | null;
    };
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
    bridgeCapabilities: {
        claudeCode: boolean;
        cursor: boolean;
    } | null;
    relayHosts: RelayHost[];
    resolving: boolean;
    lastError: string | null;
}
/** The current status, synchronously. Never throws. */
export declare function getLocalAgentStatus(): LocalAgentStatus;
/** Subscribe to status changes; returns an unsubscribe. */
export declare function onLocalAgentStatusChange(listener: (status: LocalAgentStatus) => void): () => void;
/**
 * Whether a desktop source is connected RIGHT NOW, synchronously — the answer
 * `hasRunAgent()` needs. False until `resolveLocalAgentSource()` has settled,
 * so a host that wants it true at first paint should await that once at startup.
 */
export declare function isDesktopConnected(): boolean;
/**
 * The active source, resolved once per page session (or until
 * `setLocalAgentSource` / `refreshLocalAgents` invalidates it).
 *
 * Safe to call on page load: it probes the unauthenticated `/health` endpoint
 * and lists relay hosts, neither of which raises a prompt anywhere.
 */
export declare function resolveLocalAgentSource(): Promise<LocalAgentSource | null>;
export declare function setLocalAgentSource(pref: LocalAgentSourcePref): Promise<LocalAgentSource | null>;
/** Re-probe the bridge and re-list relay hosts, then re-resolve. */
export declare function refreshLocalAgents(): Promise<LocalAgentSource | null>;
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
export declare function resolveSourceFor(pref: LocalAgentSourcePref): Promise<LocalAgentSource | null>;
/**
 * Is a UnifiedApp desktop listening on loopback? Safe to call unprompted —
 * `/health` is unauthenticated and raises no consent modal. Use it to decide
 * whether to OFFER a "Connect to desktop" affordance.
 */
export declare function checkDesktopAvailable(): Promise<boolean>;
/**
 * User-initiated pairing. PARKS on a consent modal on the desktop (120s, then
 * 403), so it must never be reached from a page-load code path — call it only
 * from an explicit user action.
 */
export declare function connectDesktop(name?: string): Promise<LocalAgentSource | null>;
/** Forget the pairing token. The desktop keeps its origin approval. */
export declare function disconnectDesktop(): Promise<void>;
/** List the account's online relay hosts. A plain GET — not a connection. */
export declare function refreshRelayHosts(): Promise<RelayHost[]>;
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
export declare function listLocalAgentDevices(snapshot?: LocalAgentStatus): LocalAgentDevice[];
/**
 * Re-probe the loopback bridge and re-list the relay hosts, then derive the
 * device list. Prompt-free, and it does NOT change the active source or the
 * saved preference — use `setLocalAgentSource()` for that.
 */
export declare function refreshLocalAgentDevices(): Promise<LocalAgentDevice[]>;
/** Which CLIs a source can run — the active one, or `pref`'s device. */
export declare function detectAgents(pref?: LocalAgentSourcePref): Promise<LocalAgentDetectResult>;
export interface CursorModelsOutput {
    ok: boolean;
    output: string;
}
/** `cursor-agent models` output from the active source, or `pref`'s device. */
export declare function cursorModelsOutput(json: boolean, pref?: LocalAgentSourcePref): Promise<CursorModelsOutput>;
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
export declare function pickWorkspaceFolder(pref?: LocalAgentSourcePref): Promise<string | null>;
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
    onExit(exit: {
        code: number | null;
        canceled: boolean;
        stderr: string;
    }): void;
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
export declare function startAgentRun(lane: Lane, args: StartArgs, handlers: RunHandlers, pref?: LocalAgentSourcePref): Promise<RunHandle>;
/** Test seam: forget the memoized source resolution and reset observable state. */
export declare function _resetLocalAgentState(): void;
//# sourceMappingURL=transport.d.ts.map