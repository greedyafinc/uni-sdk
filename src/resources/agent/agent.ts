// `sdk.agent` — the unopinionated tool-loop scaffolding.
//
// A daemon-less generalization of OpenDesign's in-process `unified-agent.ts`:
// the loop mechanics (consume the OpenAI-compatible chat stream, accumulate
// streamed tool-calls, thread messages, honor abort + a step cap, surface usage)
// are ported verbatim, but the hardcoded SYSTEM_PROMPT and file TOOLS are gone —
// the app supplies its own prompt and composes its own `ToolSpec[]` (optionally
// `fsTools()`). The loop dispatches each model tool-call to the matching
// ToolSpec the app provided, so the APP orchestrates which tools exist and what
// they do. See docs/capability-platform.md.
import type { Core } from "../../core/core";
import { RateLimitError, UnifiedError } from "../../core/errors";
import {
  type ChatCompletionChunk,
  type ChatCompletionMessage,
  type ChatCompletionStream,
  ChatCompletions,
} from "../chat";
import type { AgentEvent, RunAgentOptions, RunAgentResult, ToolSpec } from "./types";

/**
 * Lift the structured detail out of a thrown SDK error so a failed run can carry
 * the KIND of failure (not just a message) — letting callers branch on
 * `errorCode`/`errorStatus` to render a specific message. Returns only the keys
 * that apply (no `undefined` values, to satisfy `exactOptionalPropertyTypes`).
 */
function errorDetail(
  err: unknown,
): Pick<RunAgentResult, "errorCode" | "errorStatus" | "errorRetryAfter"> {
  const out: Pick<RunAgentResult, "errorCode" | "errorStatus" | "errorRetryAfter"> = {};
  if (err instanceof UnifiedError) {
    out.errorCode = err.code;
    if (err.status !== undefined) out.errorStatus = err.status;
  }
  if (err instanceof RateLimitError && err.retryAfter !== undefined) {
    out.errorRetryAfter = err.retryAfter;
  }
  return out;
}

interface ToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
}

interface StreamTurnResult {
  assistantText: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
}

// Consume one chat stream, emitting text/thinking deltas and accumulating any
// streamed tool-calls. The SDK surfaces stream-level `{error}` frames as a
// thrown error, so this only handles well-formed chunks; the caller catches.
async function consumeChatStream(
  stream: ChatCompletionStream,
  emit: (event: AgentEvent) => void,
  onText: () => void,
): Promise<StreamTurnResult> {
  let assistantText = "";
  let finishReason: string | null = null;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
  const toolAcc = new Map<number, ToolCallAccumulator>();

  for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      if (typeof delta.content === "string" && delta.content) {
        assistantText += delta.content;
        onText();
        emit({ type: "text_delta", delta: delta.content });
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        emit({ type: "thinking_delta", delta: delta.reasoning_content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === "number" ? tc.index : 0;
          const acc = toolAcc.get(index) ?? { arguments: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") acc.arguments += tc.function.arguments;
          toolAcc.set(index, acc);
        }
        // Heartbeat for the tool currently streaming (the last one with a name) so
        // a big write_file shows live byte progress rather than going silent.
        let name = "";
        let chars = 0;
        for (const acc of toolAcc.values()) if (acc.name) { name = acc.name; chars = acc.arguments.length; }
        if (name) emit({ type: "tool_partial", name, chars });
      }
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  }

  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, acc]) => ({
      id: acc.id || `call_${index}`,
      name: acc.name || "",
      arguments: acc.arguments,
    }))
    .filter((tc) => tc.name);

  return { assistantText, toolCalls, finishReason, usage };
}

/**
 * Tool-loop scaffolding. `sdk.agent.run(...)` runs the model with the app's
 * prompt + tools, dispatching tool-calls to the app's executors until the model
 * stops or `maxSteps` is hit. No prompt or tool policy is baked in.
 */
export class Agent {
  private readonly completions: ChatCompletions;

  constructor(client: Core) {
    this.completions = new ChatCompletions(client);
  }

  async run(options: RunAgentOptions): Promise<RunAgentResult> {
    const model = options.model?.trim() ? options.model : "auto";
    const maxSteps = options.maxSteps ?? 40;
    const signal = options.signal ?? new AbortController().signal;
    const emit = options.onEvent ?? (() => {});
    const tools = options.tools ?? [];
    const toolMap = new Map<string, ToolSpec>(tools.map((t) => [t.definition.function.name, t]));

    // Build the starting transcript: an explicit `messages` array wins; else
    // assemble [system?, user]. The app owns the prompt — the SDK adds nothing.
    const messages: ChatCompletionMessage[] = options.messages
      ? [...options.messages]
      : [
          ...(options.system
            ? [{ role: "system", content: options.system } as ChatCompletionMessage]
            : []),
          { role: "user", content: options.prompt ?? "" } as ChatCompletionMessage,
        ];

    let producedOutput = false;

    for (let step = 0; step < maxSteps; step++) {
      if (signal.aborted) return { ok: false, canceled: true, producedOutput, messages };

      let turn: StreamTurnResult;
      try {
        const stream = this.completions.create(
          {
            model,
            messages,
            ...(tools.length > 0
              ? { tools: tools.map((t) => t.definition), tool_choice: "auto" as const }
              : {}),
            ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal },
        );
        turn = await consumeChatStream(stream, emit, () => {
          producedOutput = true;
        });
      } catch (err) {
        if (signal.aborted) return { ok: false, canceled: true, producedOutput, messages };
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          ...errorDetail(err),
          producedOutput,
          messages,
        };
      }

      if (turn.usage) {
        // Build conditionally — `exactOptionalPropertyTypes` forbids assigning
        // an explicit `undefined` to these optional fields.
        const usage: { inputTokens?: number; outputTokens?: number } = {};
        if (turn.usage.prompt_tokens !== undefined) usage.inputTokens = turn.usage.prompt_tokens;
        if (turn.usage.completion_tokens !== undefined) {
          usage.outputTokens = turn.usage.completion_tokens;
        }
        emit({ type: "usage", usage });
      }

      const assistantMessage: ChatCompletionMessage = {
        role: "assistant",
        content: turn.assistantText || null,
        ...(turn.toolCalls.length > 0
          ? {
              tool_calls: turn.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                // A no-arg tool (e.g. `list_files`) streams its arguments as an
                // empty string. Send `"{}"` instead so the gateway can
                // `JSON.parse` it on the follow-up turn — `""` is invalid JSON
                // and 500s the next request, aborting the loop.
                function: { name: tc.name, arguments: tc.arguments.trim() ? tc.arguments : "{}" },
              })),
            }
          : {}),
      };
      messages.push(assistantMessage);

      // No tool calls → the model is done.
      if (turn.toolCalls.length === 0 || turn.finishReason !== "tool_calls") {
        // …unless it was CUT OFF at the output-token limit without producing
        // anything usable. Reasoning models can burn the whole budget on hidden
        // `reasoning_content` and end with `finish_reason: "length"` before any
        // visible text or tool call — which otherwise looks like a clean-but-empty
        // turn. Flag it so the caller can tell the user (vs. a silent no-op).
        if (turn.finishReason === "length" && !turn.assistantText.trim()) {
          return {
            ok: false,
            error:
              "The model's reply was cut off at the output-token limit before it produced any result — it likely spent the budget on internal reasoning. Retry, or switch to a different (non-reasoning) model.",
            errorCode: "response_truncated",
            producedOutput,
            messages,
          };
        }
        return { ok: true, producedOutput, messages };
      }

      // Dispatch each requested tool to the app-supplied executor, feeding
      // results back for the next turn.
      for (const tc of turn.toolCalls) {
        if (signal.aborted) return { ok: false, canceled: true, producedOutput, messages };
        let input: Record<string, unknown> = {};
        try {
          input = tc.arguments ? JSON.parse(tc.arguments) : {};
        } catch {
          input = {};
        }
        producedOutput = true;
        emit({ type: "tool_use", id: tc.id, name: tc.name, input });
        const spec = toolMap.get(tc.name);
        let result: { content: string; isError: boolean };
        if (!spec) {
          result = { content: `Unknown tool: ${tc.name}`, isError: true };
        } else {
          try {
            const r = await spec.execute(input, signal);
            result = { content: r.content, isError: r.isError === true };
          } catch (err) {
            result = { content: err instanceof Error ? err.message : String(err), isError: true };
          }
        }
        emit({
          type: "tool_result",
          toolUseId: tc.id,
          content: result.content,
          isError: result.isError,
        });
        messages.push({ role: "tool", tool_call_id: tc.id, content: result.content });
      }
    }

    // Hit the step cap — successful-but-truncated if anything was produced.
    if (producedOutput) return { ok: true, producedOutput, messages };
    return {
      ok: false,
      error: "Reached the tool-call limit without output.",
      producedOutput,
      messages,
    };
  }
}
