import type { AgentEvent } from "../../resources/agent/types";

// ---------------------------------------------------------------------------
// Claude Code
//
// Ported from UnifiedApp desktop app's src/claudeCode/agent.ts. Translates the
// locally installed `claude` (Claude Code) CLI's stream-json NDJSON events into
// the same `AgentEvent`s the SDK agent loop emits — so a chat store's rendering
// path (parts, persistence, memory capture) works untouched.
//
// Conversation continuity uses Claude Code's own session state: the `init` event
// carries a session id the caller persists per conversation and replays as
// `--resume` on later turns, sending only the newest user message.

// ---------------------------------------------------------------------------
// NDJSON event shapes (see docs.claude.com/en/docs/claude-code/sdk — `--print
// --output-format stream-json --verbose --include-partial-messages`). The
// lines arrive verbatim on every transport (Tauri IPC, loopback bridge, relay),
// which is why the translator below is the only thing that has to understand
// them.

const TOOL_RESULT_MAX_CHARS = 4000;

/** Server name in the `--mcp-config` we write (src-tauri/src/claude_code.rs). */
const MCP_TOOL_PREFIX = "mcp__unifiedapp__";

/**
 * `mcp__unifiedapp__sheets__listSheets` → `sheets__listSheets`, so the chip, detail
 * line and taint logic see the same wire name as on the gateway lane. Built-in tools
 * (`Read`, `WebSearch`, …) pass through as themselves.
 */
function claudeToolName(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
}

/** A tool result's `content` is a string or a list of content blocks. */
function stringifyToolResult(content: unknown): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block) => {
        const b = block as Record<string, unknown>;
        return typeof b?.text === "string" ? b.text : JSON.stringify(block);
      })
      .join("\n");
  } else {
    try {
      text = JSON.stringify(content ?? "");
    } catch {
      text = "[unserializable tool result]";
    }
  }
  return text.length > TOOL_RESULT_MAX_CHARS ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}…` : text;
}

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
export function createClaudeCodeStreamTranslator(onEvent: (event: AgentEvent) => void) {
  let allText = "";
  /** Text/thinking already emitted for the CURRENT assistant message. */
  let seenText = "";
  let seenThinking = "";
  /** The last aggregated message, so a re-announcement isn't emitted again. */
  let lastAggregate = "";
  let toolActivity = false;
  let sessionId: string | undefined;
  let result: ClaudeCodeStreamResult | null = null;
  /** content-block index → the in-flight tool call it is streaming arguments for. */
  const partialTools = new Map<number, { name: string; args: string }>();

  const emitText = (delta: string) => {
    if (!delta) return;
    allText += delta;
    onEvent({ type: "text_delta", delta });
  };

  /** Emit only what `full` adds beyond `seen`; returns the new `seen`. */
  const emitSuffix = (full: string, seen: string, emit: (d: string) => void): string => {
    if (full.startsWith(seen)) {
      const suffix = full.slice(seen.length);
      if (suffix.trim()) emit(suffix);
      return full;
    }
    // No deltas were streamed for this message (or they belonged to an earlier one).
    emit(full);
    return full;
  };

  const handleStreamEvent = (event: Record<string, unknown>) => {
    const index = typeof event.index === "number" ? event.index : 0;
    switch (event.type) {
      case "message_start":
        // A new assistant message: nothing of it has been shown yet.
        seenText = "";
        seenThinking = "";
        break;
      case "content_block_start": {
        const block = (event.content_block ?? {}) as Record<string, unknown>;
        if (block.type === "tool_use" && typeof block.name === "string") {
          partialTools.set(index, { name: claudeToolName(block.name), args: "" });
        }
        break;
      }
      case "content_block_delta": {
        const delta = (event.delta ?? {}) as Record<string, unknown>;
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          seenText += delta.text;
          emitText(delta.text);
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          seenThinking += delta.thinking;
          onEvent({ type: "thinking_delta", delta: delta.thinking });
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          // Live progress while a long tool call streams its arguments; the
          // dispatched `tool_use` still comes from the aggregated message.
          const pending = partialTools.get(index);
          if (pending) {
            pending.args += delta.partial_json;
            onEvent({
              type: "tool_partial",
              name: pending.name,
              chars: pending.args.length,
              args: pending.args,
            });
          }
        }
        break;
      }
      case "content_block_stop":
        partialTools.delete(index);
        break;
    }
  };

  const handleAssistantMessage = (message: Record<string, unknown>) => {
    // `<synthetic>` marks a message the CLI generated locally rather than one the
    // model produced — auth failures, API errors. The terminal `result` event
    // repeats the same text, and that is where it belongs (as the turn's error),
    // so rendering it here too would print the failure twice.
    if (message.model === "<synthetic>") return;
    const content = Array.isArray(message.content) ? message.content : [];
    const textBlocks = content.filter(
      (b) => (b as Record<string, unknown>)?.type === "text",
    ) as Array<{ text?: string }>;
    const thinkingBlocks = content.filter(
      (b) => (b as Record<string, unknown>)?.type === "thinking",
    ) as Array<{ thinking?: string }>;

    const fullThinking = thinkingBlocks.map((b) => b.thinking ?? "").join("");
    if (fullThinking) {
      seenThinking = emitSuffix(fullThinking, seenThinking, (d) =>
        onEvent({ type: "thinking_delta", delta: d }),
      );
    }

    const fullText = textBlocks.map((b) => b.text ?? "").join("");
    // A message the CLI re-announces verbatim is not new text.
    if (fullText && fullText.trim() !== lastAggregate.trim()) {
      seenText = emitSuffix(fullText, seenText, emitText);
      lastAggregate = fullText;
    }

    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b?.type !== "tool_use" || typeof b.name !== "string") continue;
      toolActivity = true;
      onEvent({
        type: "tool_use",
        id: typeof b.id === "string" ? b.id : crypto.randomUUID(),
        name: claudeToolName(b.name),
        input: b.input && typeof b.input === "object" ? (b.input as Record<string, unknown>) : {},
      });
      // A tool call ends this message; whatever text follows is new.
      seenText = "";
      lastAggregate = "";
    }
  };

  const handleLine = (line: string) => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // non-JSON noise on stdout — ignore
    }
    if (typeof ev.session_id === "string" && ev.session_id) sessionId = ev.session_id;
    // Subagent (Task tool) internals: not forwarded unless asked for, and not the
    // main thread's content when they are.
    if (ev.parent_tool_use_id) return;

    switch (ev.type) {
      case "stream_event":
        handleStreamEvent((ev.event ?? {}) as Record<string, unknown>);
        break;
      case "assistant":
        handleAssistantMessage((ev.message ?? {}) as Record<string, unknown>);
        break;
      case "user": {
        // Tool results come back as a synthetic user message.
        const message = (ev.message ?? {}) as Record<string, unknown>;
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
          onEvent({
            type: "tool_result",
            toolUseId: b.tool_use_id,
            content: stringifyToolResult(b.content),
            isError: b.is_error === true,
          });
        }
        break;
      }
      case "result": {
        const usage = (ev.usage ?? {}) as Record<string, unknown>;
        const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
        if (inputTokens || outputTokens) {
          onEvent({ type: "usage", usage: { inputTokens, outputTokens } });
        }
        result = {
          // `subtype` is "success" even for an API failure — `is_error` is the flag.
          isError: ev.is_error === true,
          text: typeof ev.result === "string" ? ev.result : "",
          ...(sessionId !== undefined ? { sessionId } : {}),
        };
        break;
      }
      // "system" (init / status / compact_boundary) carries nothing the UI renders;
      // its session_id is captured above.
    }
  };

  return {
    handleLine,
    emitText,
    get allText() {
      return allText;
    },
    get toolActivity() {
      return toolActivity;
    },
    get sessionId() {
      return sessionId;
    },
    get result() {
      return result;
    },
  };
}

/**
 * The CLI is installed but not usable until the user signs in to it — a separate
 * login from UnifiedApp's own, and the most likely first-run failure for this lane.
 * Detection is cheap (the binary exists) and deliberately does NOT probe auth, since
 * that would cost a real turn, so this is where an unauthenticated CLI surfaces.
 */
const AUTH_FAILURE_RE =
  /failed to authenticate|oauth session expired|invalid api key|not logged in|please run .*(login|auth)/i;

/** Turn a raw CLI failure into something the user can act on, keeping the detail. */
export function explainFailure(detail: string): string {
  const text = detail.trim();
  if (!AUTH_FAILURE_RE.test(text)) return text;
  return `Claude Code isn't signed in. Run \`claude\` in a terminal and sign in, then retry this message. (${text})`;
}

/**
 * A stale `--resume` id — the CLI's own session store was pruned, or the user cleared
 * it. The message only ever appears on stderr; the `result` event carries no text.
 */
export function isMissingSession(stderr: string): boolean {
  return /no conversation found/i.test(stderr);
}

// ---------------------------------------------------------------------------
// Cursor
//
// Ported from UnifiedApp desktop app's src/cursor/agent.ts. Translates the
// locally installed `cursor-agent` CLI's stream-json NDJSON events into the
// same `AgentEvent`s the SDK agent loop emits — so a chat store's rendering
// path (parts, persistence, memory capture) works untouched.
//
// Conversation continuity uses Cursor's own thread state: the first turn's
// `result` event carries a session id the caller persists per conversation and
// replays as `--resume` on later turns, sending only the newest user message.

// ---------------------------------------------------------------------------
// NDJSON event shapes (see cursor.com/docs/cli/reference/output-format). The
// lines arrive verbatim on every transport (Tauri IPC, loopback bridge, relay),
// so the translator below is the only thing that has to understand them.

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "[unserializable tool result]";
  }
}

/** Joined text blocks from an MCP CallToolResult's `content` array, when
 *  present — null when there's nothing text-shaped to show, so the caller
 *  falls back to a full JSON dump. */
function mcpToolResultText(result: Record<string, unknown>): string | null {
  const blocks = result.content;
  if (!Array.isArray(blocks)) return null;
  const text = blocks
    .filter((b): b is { text: string } => isRecord(b) && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || null;
}

/** `readToolCall` → `read`; unknown shapes fall back to `tool`. */
function cursorToolName(toolCall: Record<string, unknown>): {
  name: string;
  body: Record<string, unknown>;
} {
  const key = Object.keys(toolCall)[0];
  if (!key) return { name: "tool", body: {} };
  const body = toolCall[key];
  return {
    name: key.replace(/ToolCall$/, ""),
    body: body && typeof body === "object" ? (body as Record<string, unknown>) : {},
  };
}

export interface CursorStreamResult {
  isError: boolean;
  text: string;
  sessionId?: string;
}

/**
 * Stateful translator from cursor-agent stream-json NDJSON lines to AgentEvents.
 * Pure w.r.t. IPC — exported separately from runCursorTurn so it's unit-testable.
 */
export function createCursorStreamTranslator(onEvent: (event: AgentEvent) => void) {
  let allText = "";
  // Text already emitted for the CURRENT assistant segment. With
  // --stream-partial-output each segment arrives as incremental deltas followed
  // by one aggregated message repeating the whole segment; emitting only the
  // aggregate's unseen suffix keeps both shapes correct without double-rendering.
  let segmentText = "";
  // The last aggregated segment, so a re-announcement is recognised even when it
  // differs only in trailing whitespace.
  let lastAggregate = "";
  let toolActivity = false;
  let result: CursorStreamResult | null = null;

  const emitText = (delta: string) => {
    if (!delta) return;
    allText += delta;
    onEvent({ type: "text_delta", delta });
  };

  const handleLine = (line: string) => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // non-JSON noise on stdout — ignore
    }
    switch (ev.type) {
      case "assistant": {
        const message = ev.message as { content?: Array<{ type?: string; text?: string }> };
        const text = (message?.content ?? [])
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("");
        if (!text) break;
        // Which shape is this? `model_call_id` marks the aggregated segment
        // summary — deltas never carry it. Do NOT test `timestamp_ms`: current
        // cursor-agent stamps BOTH shapes with it, so treating its presence as
        // "this is a delta" sent the aggregate down the delta path and appended
        // the whole segment a second time — every answer rendered twice.
        // Older builds omit both fields on the aggregate, hence the fallback.
        const isDelta = "timestamp_ms" in ev && !("model_call_id" in ev);
        if (isDelta) {
          // Streaming delta: incremental text.
          segmentText += text;
          emitText(text);
        } else {
          // Aggregated segment. `segmentText` holds everything already shown for
          // this segment and is NOT cleared here — clearing it was the duplicate
          // bug, because `text.startsWith("")` is always true, so a re-announced
          // segment fell into the suffix branch and re-emitted the whole answer.
          // Only a tool call (a real segment boundary) clears it.
          if (text.startsWith(segmentText)) {
            // Normal close, or a re-announcement (suffix is empty). A
            // whitespace-only suffix is a re-announcement that differs just in
            // trailing newlines — never worth emitting.
            const suffix = text.slice(segmentText.length);
            if (suffix.trim()) emitText(suffix);
            segmentText = text;
          } else if (text.trim() !== lastAggregate.trim()) {
            // A CLI that sends whole segments and no deltas: this is the next
            // segment, not a repeat of the last one.
            emitText(text);
            segmentText += text;
          }
          lastAggregate = text;
        }
        break;
      }
      case "thinking": {
        // Reasoning channel (undocumented but emitted): `{type:"thinking",
        // subtype:"delta", text}` then a `completed` marker.
        if (ev.subtype === "delta" && typeof ev.text === "string" && ev.text) {
          onEvent({ type: "thinking_delta", delta: ev.text });
        }
        break;
      }
      case "tool_call": {
        const callId = typeof ev.call_id === "string" ? ev.call_id : crypto.randomUUID();
        let { name, body } = cursorToolName((ev.tool_call as Record<string, unknown>) ?? {});
        let args = body.args;
        if (name === "mcp") {
          // Our own tools arrive as `mcpToolCall` with args `{name: "<server>-<tool>",
          // args}` — surface the real wire name (e.g. `sheets__listSheets`) so the
          // chip, detail line and taint logic see the same name as on the gateway lane.
          const a = (args ?? {}) as Record<string, unknown>;
          if (typeof a.name === "string") name = a.name.replace(/^unifiedapp-/, "");
          args = a.args;
        }
        toolActivity = true;
        // A tool call ends the current text segment and opens a new one, so the
        // next aggregate is new text even if it repeats the previous segment.
        segmentText = "";
        lastAggregate = "";
        if (ev.subtype === "started") {
          onEvent({
            type: "tool_use",
            id: callId,
            name,
            input: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
          });
        } else if (ev.subtype === "completed") {
          const res = body.result as Record<string, unknown> | undefined;
          let isError: boolean;
          let content: string;
          if (!res) {
            // No result at all — a missing `result` is a failure, not the
            // success `!!res` used to treat it as.
            isError = true;
            content = "[no tool result]";
          } else if ("success" in res) {
            if (isRecord(res.success)) {
              // cursor-agent wraps our MCP CallToolResult INSIDE `result.success`
              // (`{content: [...], isError}`) rather than surfacing it directly, so
              // the outer "success" key alone can't tell a real tool failure from a
              // real tool success — only the nested `isError` can.
              isError = res.success.isError === true;
              content = mcpToolResultText(res.success) ?? safeStringify(res.success);
            } else {
              isError = false;
              content = safeStringify(res.success);
            }
          } else {
            // `{error: …}` / `{rejected: …}` / any other non-success shape.
            isError = true;
            content = safeStringify(res);
          }
          if (content.length > TOOL_RESULT_MAX_CHARS) {
            content = `${content.slice(0, TOOL_RESULT_MAX_CHARS)}…`;
          }
          onEvent({ type: "tool_result", toolUseId: callId, content, isError });
        }
        break;
      }
      case "result": {
        result = {
          isError: ev.is_error === true,
          text: typeof ev.result === "string" ? ev.result : "",
          ...(typeof ev.session_id === "string" ? { sessionId: ev.session_id } : {}),
        };
        break;
      }
      // "system" (init) and "user" echoes carry nothing the UI renders.
    }
  };

  return {
    handleLine,
    emitText,
    get allText() {
      return allText;
    },
    get toolActivity() {
      return toolActivity;
    },
    get result() {
      return result;
    },
  };
}
