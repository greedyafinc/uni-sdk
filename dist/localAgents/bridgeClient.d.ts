/** Ports the desktop server tries, in order (agent-bridge.md § Discovery). */
export declare const BRIDGE_PORTS: readonly [47825, 47826, 47827, 47828, 47829];
export interface BridgeDetectResult {
    claudeCode: {
        found: boolean;
        path: string | null;
    };
    cursor: {
        found: boolean;
        path: string | null;
    };
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
    onExit(exit: {
        code: number | null;
        canceled: boolean;
        stderr: string;
    }): void;
    onMcpList?(id: string): void;
    onMcpCall?(id: string, name: string, args: unknown): void;
    /** Transport-level failure (stream died before `exit`). */
    onError?(message: string): void;
}
export interface BridgeEventStream {
    close(): void;
}
/** The pairing token from a previous session, if any. */
export declare function bridgeToken(): string | null;
/**
 * Whether this origin has paired before. Source selection uses this as the
 * auto-activation gate: a page that has never paired must not probe its way
 * into raising a consent modal on somebody's desktop at page load.
 */
export declare function hasBridgeToken(): boolean;
/** Forget the token ("Disconnect", or a 401 we could not re-pair through). */
export declare function clearBridgeToken(): void;
export declare function bridgeOrigin(port: number): string;
/**
 * Find the running bridge, preferring the port that worked last time.
 * Returns null when no desktop app is listening.
 */
export declare function discoverBridge(force?: boolean): Promise<number | null>;
/** Drop the memoized port so the next call re-probes the range. */
export declare function invalidateBridgePort(): void;
/** Whether a bridge is reachable at all (no pairing required). */
export declare function bridgeHealth(): Promise<{
    ok: boolean;
    port: number | null;
}>;
/**
 * Ask the desktop for a token for this origin.
 *
 * First time for an origin this PARKS until the user answers a consent modal on
 * the desktop (120s, then 403) — so only call it from an explicit user action.
 * A previously approved origin re-mints immediately and silently, which is what
 * makes `reauthorize()` below safe to run inside a failed request.
 */
export declare function pairBridge(name?: string, silent?: boolean): Promise<string>;
/**
 * A human label for the consent modal — the browser's origin is shown by the
 * desktop alongside it. `configureLocalAgents({ clientName })` overrides the
 * generic product name, so a surface the user already recognizes (the web
 * client, a named marketplace app) is named as itself on the card rather than
 * as "some UnifiedAI app".
 */
export declare function defaultPairName(): string;
export declare function bridgeDetect(): Promise<BridgeDetectResult>;
export declare function bridgeCursorModels(json: boolean): Promise<string>;
export declare function bridgeStartRun(body: BridgeStartBody): Promise<void>;
export declare function bridgeStopRun(runId: string): Promise<void>;
export declare function bridgeMcpResult(id: string, result: unknown): Promise<void>;
/** Opens the desktop's native folder dialog. Long request; one at a time. */
export declare function bridgePickFolder(): Promise<string | null>;
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
export declare function openRunEvents(runId: string, handlers: BridgeRunHandlers): Promise<BridgeEventStream>;
/** Parse one `event:`/`data:` frame and route it. Exported for tests. */
export declare function dispatchFrame(frame: string, handlers: BridgeRunHandlers): void;
//# sourceMappingURL=bridgeClient.d.ts.map