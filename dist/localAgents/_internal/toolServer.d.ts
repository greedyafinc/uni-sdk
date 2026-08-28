import type { ToolSpec } from "../../resources/agent/types.js";
/** MCP `Tool` as listed to the client. */
export interface McpToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
/** MCP `CallToolResult`. */
export interface McpCallResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    isError: boolean;
}
/** Deterministic JSON — object keys sorted recursively, array order preserved. */
export declare function stableStringify(value: unknown): string;
/** OpenAI function definition → MCP tool. */
export declare function toMcpToolDef(spec: ToolSpec): McpToolDef;
export interface ToolServer {
    /** The run's tools as MCP defs. Re-reads the array, so a deferred load mid-run is visible. */
    list(): McpToolDef[];
    /** Execute one tool by wire name, with the in-flight dedup applied. */
    call(name: string, args: unknown): Promise<McpCallResult>;
}
/**
 * Serve `tools` (a LIVE array — the SDK agent loop's deferred-tool contract
 * lets a tool push more specs into it mid-run, and `list()` re-reads it, so the
 * agent's next `tools/list` sees them) for the duration of one run.
 */
export declare function createToolServer(tools: ToolSpec[] | undefined, signal: AbortSignal): ToolServer;
//# sourceMappingURL=toolServer.d.ts.map