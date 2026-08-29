import type { ChatCompletionMessage } from "../../resources/chat.js";
/**
 * When the composed request has prior turns but the agent has no session yet
 * (conversation started on a gateway model, or the session map was lost), fold the
 * visible history into the first prompt so the agent isn't answering blind.
 * System blocks are NOT part of the transcript — they are delivered per turn by
 * `systemText` below, not folded in once.
 */
export declare function foldHistoryPrompt(messages: ChatCompletionMessage[], userText: string, hasSession: boolean): string;
/**
 * The app's system instructions as one block, in order. A composed request often
 * carries several (memory lane, tool prompt, page context); the gateway
 * concatenates them and so do we. Empty when the caller sent none.
 */
export declare function systemText(messages: ChatCompletionMessage[]): string;
/**
 * Prefix system instructions onto a prompt, for a lane with no system-prompt
 * flag of its own (Cursor's CLI has none — checked against `cursor-agent --help`,
 * which offers only workspace-level rules files). Labelled rather than pasted
 * bare so the agent can tell the app's standing instructions from the user's
 * words; on lanes that DO take a real system prompt, this is not used.
 */
export declare function withSystemPrompt(system: string, prompt: string): string;
/** localStorage key for Claude Code's per-conversation session ids. */
export declare const CLAUDE_CODE_SESSIONS_KEY = "unified.claudeCodeSessions";
/** localStorage key for Cursor's per-conversation thread ids. */
export declare const CURSOR_SESSIONS_KEY = "unified.cursorSessions";
/**
 * Marker for a one-shot conversation id — a fan-out worker or any caller that wants
 * a fresh agent thread it will never return to. These are never persisted: the id is
 * unique per turn, so storing it would grow the session map without bound and never
 * produce a hit.
 */
export declare const EPHEMERAL_CONVERSATION_PREFIX = "ephemeral:";
export declare function isEphemeralConversation(conversationId: string): boolean;
/**
 * Scope a conversation's agent session to the workspace it ran in. The CLIs key
 * their on-disk session stores by cwd (Claude Code literally cannot `--resume` a
 * session from a different directory), so attaching, removing, or switching a
 * code workspace must look like a brand-new agent thread — the history is folded
 * back into the first prompt of the new scope. Keeps `conversationId` as the
 * prefix so the ephemeral-conversation check still applies.
 */
export declare function sessionScope(conversationId: string, workspace?: string | null): string;
export declare function sessionFor(key: string, conversationId: string): string | null;
/** Drop a stored session id — the agent no longer has that thread. */
export declare function forgetSession(key: string, conversationId: string): void;
export declare function rememberSession(key: string, conversationId: string, sessionId: string): void;
//# sourceMappingURL=prompt.d.ts.map