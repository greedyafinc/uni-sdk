// Answers a local CLI's MCP round-trips from the caller's OWN `ToolSpec[]`.
//
// Both wire contracts forward the CLI's `tools/list` and `tools/call` to the
// client that started the run (bridge: `mcp-list` / `mcp-call` SSE events →
// `POST /mcp/result`; relay: the same-named frames → `mcp-result`). The tools
// therefore execute HERE, in the caller's context, with the caller's own
// consent/permission wrapping — which is the whole point of the design.
//
// Port of the desktop's `agentCli/mcpBridge.ts`, minus its Tauri listeners and
// module-singleton turn state: the SDK has no shell, so the tool set is scoped
// to one run instead of one webview.
import type { ToolSpec } from "../../resources/agent/types";

/** MCP `Tool` as listed to the client. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP `CallToolResult`. */
export interface McpCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

/** Deterministic JSON — object keys sorted recursively, array order preserved. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** Dedup key for a call — tool wire names can't contain a space. */
function inflightKey(name: string, args: unknown): string {
  return `${name} ${stableStringify(args)}`;
}

/** OpenAI function definition → MCP tool. */
export function toMcpToolDef(spec: ToolSpec): McpToolDef {
  const fn = spec.definition.function;
  return {
    name: fn.name,
    description: fn.description ?? "",
    inputSchema: (fn.parameters as Record<string, unknown> | undefined) ?? {
      type: "object",
      properties: {},
    },
  };
}

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
export function createToolServer(tools: ToolSpec[] | undefined, signal: AbortSignal): ToolServer {
  /**
   * Calls currently executing, keyed by tool name + canonical args. A consent
   * card can block a `tools/call` for minutes; the CLI's own MCP client timeout
   * is often shorter and re-issues the identical call. Rather than start a
   * second execution (a second consent card, possibly a second real write), a
   * duplicate attaches to the pending promise and both request ids get the same
   * result. In-flight only — once a call settles its entry is removed, so a
   * later identical call runs fresh.
   */
  const inflight = new Map<string, Promise<McpCallResult>>();

  async function execute(name: string, args: unknown): Promise<McpCallResult> {
    const spec = tools?.find((t) => t.definition.function.name === name);
    if (!spec) {
      return {
        content: [{ type: "text", text: `tool "${name}" is not available` }],
        isError: true,
      };
    }
    const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    try {
      const result = await spec.execute(input, signal);
      return { content: [{ type: "text", text: result.content }], isError: !!result.isError };
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  }

  return {
    list() {
      return (tools ?? []).map(toMcpToolDef);
    },
    call(name, args) {
      const key = inflightKey(name, args);
      let call = inflight.get(key);
      if (!call) {
        call = execute(name, args).finally(() => {
          if (inflight.get(key) === call) inflight.delete(key);
        });
        inflight.set(key, call);
      }
      return call;
    },
  };
}
