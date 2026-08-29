import type { AgentEvent } from "../../resources/agent/types.js";
export interface ClaudeCodeStreamResult {
    isError: boolean;
    text: string;
    sessionId?: string;
}
/**
 * Stateful translator from Claude Code stream-json NDJSON lines to AgentEvents.
 * Pure w.r.t. IPC — exported separately from runClaudeCodeTurn so it's unit-testable.
 *
 * Both shapes of the same content arrive: token-level deltas (`stream_event`) and,
 * when the assistant message closes, the whole message again (`assistant`). We emit
 * the deltas and then only the aggregate's UNSEEN suffix, so nothing renders twice —
 * and a CLI without `--include-partial-messages` support still renders, because then
 * the suffix is the entire message.
 */
export declare function createClaudeCodeStreamTranslator(onEvent: (event: AgentEvent) => void): {
    handleLine: (line: string) => void;
    emitText: (delta: string) => void;
    readonly allText: string;
    readonly toolActivity: boolean;
    readonly sessionId: string | undefined;
    readonly result: ClaudeCodeStreamResult | null;
};
/** Turn a raw CLI failure into something the user can act on, keeping the detail. */
export declare function explainFailure(detail: string): string;
/**
 * A stale `--resume` id — the CLI's own session store was pruned, or the user cleared
 * it. The message only ever appears on stderr; the `result` event carries no text.
 */
export declare function isMissingSession(stderr: string): boolean;
export interface CursorStreamResult {
    isError: boolean;
    text: string;
    sessionId?: string;
}
/**
 * Stateful translator from cursor-agent stream-json NDJSON lines to AgentEvents.
 * Pure w.r.t. IPC — exported separately from runCursorTurn so it's unit-testable.
 */
export declare function createCursorStreamTranslator(onEvent: (event: AgentEvent) => void): {
    handleLine: (line: string) => void;
    emitText: (delta: string) => void;
    readonly allText: string;
    readonly toolActivity: boolean;
    readonly result: CursorStreamResult | null;
};
//# sourceMappingURL=translators.d.ts.map