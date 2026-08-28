import type { AgentEvent, RunAgentResult, ToolSpec } from "../resources/agent/types.js";
import type { ChatCompletionMessage, ChatCompletionUserContentPart } from "../resources/chat.js";
import { type LocalAgentSourcePref } from "./transport.js";
export interface RunLocalAgentOptions {
    /** A `claude-code/*` or `cursor/*` id. Anything else rejects. */
    model: string;
    /**
     * The full transcript to start from — `system` blocks included, and honored:
     * they become the agent's system prompt (or, on a lane with no such flag, a
     * labelled block at the head of the prompt) on EVERY turn, exactly as the
     * gateway would. That is what makes picking a local model a provider swap
     * rather than a jump into someone else's coding agent.
     */
    messages?: ChatCompletionMessage[];
    /**
     * System instructions, overriding any `system` blocks in `messages`. Callers
     * that keep the system prompt out of the transcript pass it here.
     */
    system?: string;
    /**
     * The newest user turn. When omitted it is taken from the last user message in
     * `messages`. Multimodal parts are flattened to their text — a local CLI takes
     * text only, and dropping the rest beats failing the turn.
     */
    prompt?: string | ChatCompletionUserContentPart[];
    /**
     * Tools the CLI may call, served to it over the desktop's per-run MCP server.
     * A LIVE array: a tool that pushes more specs into it mid-run is visible to
     * the agent's next `tools/list`, exactly as in the SDK agent loop. Each call
     * runs the spec's own `execute` HERE, in this page's context.
     */
    tools?: ToolSpec[];
    signal?: AbortSignal;
    onEvent?: (event: AgentEvent) => void;
    /**
     * Code-work mode: run in this real directory on the DESKTOP instead of the
     * app's scratch workspace. Get the path from `pickWorkspaceFolder()` — the
     * host only honors `trustWorkspace` for folders its own user picked there.
     */
    workspace?: string;
    /** Write access for `workspace`. Must reflect an explicit user opt-in, never a default. */
    trustWorkspace?: boolean;
    /** Additional attached folders, passed as `--add-dir` (code-work mode only). */
    extraDirs?: string[];
    /** Claude Code `--effort` level. Ignored on the Cursor lane (effort is a sibling model id there). */
    effort?: string | null;
    /**
     * Stable key for multi-turn continuity — it maps to the CLI's own thread state
     * (`--resume`). OMIT it for a fresh, throwaway session: that is the right
     * choice for subagents and any fan-out worker, which must not inherit or
     * mutate the parent thread's context.
     */
    conversationId?: string;
    /**
     * Run on a SPECIFIC device instead of the active source — the per-surface
     * compute choice. Take it from `listLocalAgentDevices()[n].pref`. Omitted, the
     * turn runs wherever the global source selection points.
     */
    source?: LocalAgentSourcePref;
}
/**
 * Run one turn on the active local source.
 *
 * Never rejects for an ordinary failure: like `sdk.agent.run`, a failed turn
 * comes back as `{ ok: false, error }`. It DOES reject when `model` is not a
 * local-agent id — that is a caller bug, not a turn outcome.
 *
 * The fields a local lane cannot produce (`errorCode`, `errorStatus`,
 * `finishReason`, `usage` totals) stay absent, which is what
 * `isLocalAgentModel()` warns callers about.
 */
export declare function runLocalAgent(opts: RunLocalAgentOptions): Promise<RunAgentResult>;
//# sourceMappingURL=run.d.ts.map