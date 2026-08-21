// Barrel for the agent resource. Re-exported from the SDK's browser + node
// entries. All of this is browser-safe (no `node:*` imports).
//
// Note: `webTools()` is browser-safe at the module level (fetch only), but
// DuckDuckGo HTML search is blocked by CORS in real browsers — use it from
// Node / node-service / CLI, or inject a CORS-friendly `search` backend.
export { Agent } from "./agent";
export { fsTools } from "./fs-tools";
export { webTools } from "./web-tools";
export type {
  SearchBackend,
  SearchHit,
  SearchOptions,
  WebToolsOptions,
  FetchLike,
} from "./web-tools";
export type {
  AgentEvent,
  RunAgentOptions,
  RunAgentResult,
  ToolResult,
  ToolSpec,
} from "./types";
