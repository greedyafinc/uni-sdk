// Shared prompt composition + session continuity for the local-agent CLI lanes.
// Port of the desktop's `agentCli/prompt.ts`; the localStorage keys are the
// SAME, so a browser that runs both surfaces resumes the same CLI threads.
import type { ChatCompletionMessage } from "../../resources/chat";

/**
 * When the composed request has prior turns but the agent has no session yet
 * (conversation started on a gateway model, or the session map was lost), fold the
 * visible history into the first prompt so the agent isn't answering blind.
 * System blocks are NOT part of the transcript — they are delivered per turn by
 * `systemText` below, not folded in once.
 */
export function foldHistoryPrompt(
  messages: ChatCompletionMessage[],
  userText: string,
  hasSession: boolean,
): string {
  if (hasSession) return userText;
  const history = messages.filter(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      m.content.trim(),
  ) as Array<{ role: string; content: string }>;
  // The newest user message is already in the composed request — drop it from the
  // transcript block so it isn't sent twice.
  if (history.length && history[history.length - 1]?.content === userText) history.pop();
  if (!history.length) return userText;
  const transcript = history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  return `Earlier conversation for context:\n\n${transcript}\n\n---\n\n${userText}`;
}

// ---------------------------------------------------------------------------
// The calling app's system instructions.
//
// A local CLI ships its own system prompt — a CODING agent's, naming itself and
// describing a workspace. That is the right prompt for the desktop's code-work
// mode and the wrong one everywhere else: an app that picks a `claude-code/*` or
// `cursor/*` model is picking a MODEL, and expects it to behave like any gateway
// model behind the same chat. Dropping the app's `system` blocks left it talking
// to the CLI's persona instead of the app's, which is what made a local model
// feel like remote access to Cursor rather than a provider swap.
//
// So the app's system blocks are delivered on EVERY turn, exactly as they are to
// the gateway. They are per-turn state, not history: notes rebuilds its prompt
// each turn from the open note and the caret, so folding it in once at session
// start would pin the agent to a stale view of the app.

/**
 * The app's system instructions as one block, in order. A composed request often
 * carries several (memory lane, tool prompt, page context); the gateway
 * concatenates them and so do we. Empty when the caller sent none.
 */
export function systemText(messages: ChatCompletionMessage[]): string {
  return messages
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => (m.content as string).trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Prefix system instructions onto a prompt, for a lane with no system-prompt
 * flag of its own (Cursor's CLI has none — checked against `cursor-agent --help`,
 * which offers only workspace-level rules files). Labelled rather than pasted
 * bare so the agent can tell the app's standing instructions from the user's
 * words; on lanes that DO take a real system prompt, this is not used.
 */
export function withSystemPrompt(system: string, prompt: string): string {
  if (!system) return prompt;
  return `<system-instructions>\n${system}\n</system-instructions>\n\n${prompt}`;
}

// ---------------------------------------------------------------------------
// Per-conversation agent session ids (for `--resume`), localStorage-persisted so a
// reopened thread keeps its agent-side context. Each lane passes its own key.

/** localStorage key for Claude Code's per-conversation session ids. */
export const CLAUDE_CODE_SESSIONS_KEY = "unified.claudeCodeSessions";
/** localStorage key for Cursor's per-conversation thread ids. */
export const CURSOR_SESSIONS_KEY = "unified.cursorSessions";

/**
 * Marker for a one-shot conversation id — a fan-out worker or any caller that wants
 * a fresh agent thread it will never return to. These are never persisted: the id is
 * unique per turn, so storing it would grow the session map without bound and never
 * produce a hit.
 */
export const EPHEMERAL_CONVERSATION_PREFIX = "ephemeral:";

export function isEphemeralConversation(conversationId: string): boolean {
  return conversationId.startsWith(EPHEMERAL_CONVERSATION_PREFIX);
}

/**
 * Scope a conversation's agent session to the workspace it ran in. The CLIs key
 * their on-disk session stores by cwd (Claude Code literally cannot `--resume` a
 * session from a different directory), so attaching, removing, or switching a
 * code workspace must look like a brand-new agent thread — the history is folded
 * back into the first prompt of the new scope. Keeps `conversationId` as the
 * prefix so the ephemeral-conversation check still applies.
 */
export function sessionScope(conversationId: string, workspace?: string | null): string {
  return workspace ? `${conversationId} ws:${workspace}` : conversationId;
}

function loadSessions(key: string): Record<string, string> {
  try {
    const raw = globalThis.localStorage?.getItem(key) ?? null;
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function sessionFor(key: string, conversationId: string): string | null {
  if (isEphemeralConversation(conversationId)) return null;
  return loadSessions(key)[conversationId] ?? null;
}

/** Drop a stored session id — the agent no longer has that thread. */
export function forgetSession(key: string, conversationId: string): void {
  try {
    const sessions = loadSessions(key);
    delete sessions[conversationId];
    globalThis.localStorage?.setItem(key, JSON.stringify(sessions));
  } catch {
    // fail-soft
  }
}

export function rememberSession(key: string, conversationId: string, sessionId: string): void {
  if (isEphemeralConversation(conversationId)) return;
  try {
    const sessions = loadSessions(key);
    sessions[conversationId] = sessionId;
    globalThis.localStorage?.setItem(key, JSON.stringify(sessions));
  } catch {
    // fail-soft: worst case the next turn starts a fresh agent thread
  }
}
