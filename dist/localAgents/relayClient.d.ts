import { Observable } from "../core/_internal/observable.js";
export interface RelayCapabilities {
    claudeCode: {
        found: boolean;
    };
    cursor: {
        found: boolean;
    };
}
export interface RelayHost {
    deviceId: string;
    deviceName: string;
    capabilities: RelayCapabilities;
    connectedAt?: string;
}
export type ApprovalState = "unknown" | "pending" | "approved" | "denied";
export interface RelayDetectResult {
    claudeCode: {
        found: boolean;
        path: string | null;
    };
    cursor: {
        found: boolean;
        path: string | null;
    };
}
export interface RelayRunHandlers {
    onLine(line: string): void;
    onExit(exit: {
        code: number | null;
        canceled: boolean;
        stderr: string;
    }): void;
    onMcpList?(id: string): void;
    onMcpCall?(id: string, name: string, args: unknown): void;
}
export interface RelayStartArgs {
    runId: string;
    lane: "claude-code" | "cursor";
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
/**
 * The account's currently online hosts. A plain authenticated GET — listing is
 * NOT a connection, so it is safe to call while merely deciding which compute
 * source to offer, and it raises no consent anywhere.
 *
 * Goes through the ordinary `/api/v1/*` path the rest of the SDK uses (a dev
 * proxy handles it in standalone dev); only the WebSockets below need an
 * absolute base.
 */
export declare function listRelayHosts(): Promise<RelayHost[]>;
/**
 * Relay WebSockets connect to unified-api DIRECTLY rather than through the
 * local proxies the HTTP calls use: dev proxies do not handle upgrades
 * reliably. `relayWsBase()` resolves the absolute unified-api base (see
 * config.ts), so `/relay/*` hangs off it directly.
 */
export declare function relayWsUrl(path: string): string;
/**
 * Browsers cannot set headers on a WebSocket handshake, so the token rides the
 * subprotocol (agent-relay.md § WS auth). The server echoes the selected
 * subprotocol back.
 */
export declare function bearerSubprotocol(): Promise<string | null>;
export declare function clientDeviceId(): string;
export declare function clientDeviceName(): string;
export interface RelayConnection {
    readonly deviceId: string;
    /** Observable so a UI can render live state without polling. */
    readonly approval: Observable<ApprovalState>;
    readonly connected: Observable<boolean>;
    readonly host: Observable<RelayHost | null>;
    readonly lastError: Observable<string | null>;
    /** Resolves once the socket is attached AND the host has approved this device. */
    ready(timeoutMs?: number): Promise<void>;
    detect(): Promise<RelayDetectResult>;
    cursorModels(json: boolean): Promise<string>;
    pickFolder(): Promise<string | null>;
    startRun(args: RelayStartArgs, handlers: RelayRunHandlers): Promise<void>;
    stopRun(runId: string): void;
    mcpResult(id: string, result: unknown): void;
    close(): void;
}
export declare function connectRelayHost(deviceId: string): RelayConnection;
/** Drop a cached connection ("disconnect", source switch). */
export declare function closeRelayHost(deviceId: string): void;
export declare function closeAllRelayHosts(): void;
//# sourceMappingURL=relayClient.d.ts.map