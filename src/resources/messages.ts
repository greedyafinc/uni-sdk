import { parseSSE } from "../core/_internal/sse";
import { UnifiedStream } from "../core/_internal/stream";
import type { Core, RequestOptions } from "../core/core";
import { UnifiedAIError } from "../core/errors";

// ── Content blocks (Anthropic Messages, mirrored from unified-api) ────────────

export type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export type AnthropicImageSource =
  | { type: "base64"; media_type: AnthropicImageMediaType; data: string }
  | { type: "url"; url: string }
  | { type: "file"; file_id: string };

export type AnthropicDocumentSource =
  | { type: "base64"; media_type: "application/pdf"; data: string }
  | { type: "url"; url: string }
  | { type: "file"; file_id: string };

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: AnthropicImageSource }
  | { type: "document"; source: AnthropicDocumentSource }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content?: string | Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock>;
      is_error?: boolean;
    }
  | { type: "thinking"; thinking: string; signature: string };

export type AnthropicTextBlock = Extract<AnthropicContentBlock, { type: "text" }>;
export type AnthropicImageBlock = Extract<AnthropicContentBlock, { type: "image" }>;
export type AnthropicDocumentBlock = Extract<AnthropicContentBlock, { type: "document" }>;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: unknown;
}

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

export interface MessageCreateParams {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | Array<{ type: "text"; text: string }>;
  metadata?: { user_id?: string };
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: AnthropicToolDefinition[];
  tool_choice?: AnthropicToolChoice;
  thinking?: { type: "enabled"; budget_tokens: number };
  /**
   * Ask the gateway to deterministically compress older conversation context
   * (tool results, long prior assistant turns) server-side before routing.
   * Falls back to the client-level `compression` default when unset; an
   * explicit `false` here overrides a client default of `true`.
   */
  compression?: boolean;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  stop_sequence?: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

export interface MessageCreateOptions {
  signal?: AbortSignal;
}

// ── Streaming event types (Anthropic Messages) ────────────────────────────────

export type MessageStreamEvent =
  | {
      type: "message_start";
      message: Omit<AnthropicMessageResponse, "content" | "stop_reason" | "stop_sequence"> & {
        content: AnthropicContentBlock[];
        stop_reason: AnthropicMessageResponse["stop_reason"];
        stop_sequence?: string | null;
      };
    }
  | {
      type: "content_block_start";
      index: number;
      content_block: AnthropicContentBlock;
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: {
        stop_reason?: AnthropicMessageResponse["stop_reason"];
        stop_sequence?: string | null;
      };
      usage?: { output_tokens?: number };
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

// Parity with the Anthropic SDK's `.stream()` helper: callers who don't want to
// walk events can `await stream.finalMessage()` to drain and get the assembled
// response. Internally drains the same async iterator the consumer would walk.
export class MessageStream extends UnifiedStream<MessageStreamEvent> {
  private finalPromise: Promise<AnthropicMessageResponse> | null = null;

  finalMessage(): Promise<AnthropicMessageResponse> {
    if (!this.finalPromise) this.finalPromise = aggregateFinalMessage(this);
    return this.finalPromise;
  }
}

async function aggregateFinalMessage(
  stream: AsyncIterable<MessageStreamEvent>,
): Promise<AnthropicMessageResponse> {
  let message: AnthropicMessageResponse | null = null;
  const partialJson: Record<number, string> = {};
  for await (const ev of stream) {
    switch (ev.type) {
      case "message_start": {
        const m = ev.message;
        message = {
          id: m.id,
          type: "message",
          role: m.role,
          model: m.model,
          content: [],
          stop_reason: m.stop_reason ?? null,
          stop_sequence: m.stop_sequence ?? null,
          usage: {
            input_tokens: m.usage?.input_tokens ?? 0,
            output_tokens: m.usage?.output_tokens ?? 0,
          },
        };
        break;
      }
      case "content_block_start": {
        if (!message) break;
        // Clone the seed block so subsequent deltas mutate our copy, not the event.
        const block = JSON.parse(JSON.stringify(ev.content_block)) as AnthropicContentBlock;
        if (block.type === "tool_use") {
          block.input = block.input ?? {};
          partialJson[ev.index] = "";
        }
        message.content[ev.index] = block;
        break;
      }
      case "content_block_delta": {
        if (!message) break;
        const block = message.content[ev.index];
        if (!block) break;
        const d = ev.delta;
        if (d.type === "text_delta" && block.type === "text") {
          block.text += d.text;
        } else if (d.type === "input_json_delta" && block.type === "tool_use") {
          partialJson[ev.index] = (partialJson[ev.index] ?? "") + d.partial_json;
        } else if (d.type === "thinking_delta" && block.type === "thinking") {
          block.thinking += d.thinking;
        } else if (d.type === "signature_delta" && block.type === "thinking") {
          block.signature = d.signature;
        }
        break;
      }
      case "content_block_stop": {
        if (!message) break;
        const block = message.content[ev.index];
        if (block?.type === "tool_use") {
          const raw = partialJson[ev.index];
          if (raw && raw.length > 0) {
            try {
              block.input = JSON.parse(raw);
            } catch {
              // Leave the seeded input as-is on malformed JSON.
            }
          }
          delete partialJson[ev.index];
        }
        break;
      }
      case "message_delta": {
        if (!message) break;
        if (ev.delta.stop_reason !== undefined) message.stop_reason = ev.delta.stop_reason;
        if (ev.delta.stop_sequence !== undefined) message.stop_sequence = ev.delta.stop_sequence;
        if (ev.usage?.output_tokens !== undefined) {
          message.usage.output_tokens = ev.usage.output_tokens;
        }
        break;
      }
      case "message_stop":
      case "ping":
      case "error":
        break;
    }
  }
  if (!message) {
    throw new UnifiedAIError(
      "request_failed",
      "messages stream ended before message_start",
      0,
      null,
    );
  }
  return message;
}

export class Messages {
  constructor(private readonly client: Core) {}

  create(
    params: MessageCreateParams & { stream: true },
    options?: MessageCreateOptions,
  ): MessageStream;
  create(
    params: MessageCreateParams & { stream?: false },
    options?: MessageCreateOptions,
  ): Promise<AnthropicMessageResponse>;
  create(
    params: MessageCreateParams & { stream?: boolean },
    options: MessageCreateOptions = {},
  ): MessageStream | Promise<AnthropicMessageResponse> {
    if (params.stream) {
      return this.createStream(params as MessageCreateParams & { stream: true }, options);
    }
    const req: RequestOptions = {
      method: "POST",
      body: { ...params, compression: params.compression ?? this.client.defaultCompression },
    };
    if (options.signal) req.signal = options.signal;
    return this.client.request<AnthropicMessageResponse>("/v1/messages", req);
  }

  private createStream(
    params: MessageCreateParams & { stream: true },
    options: MessageCreateOptions,
  ): MessageStream {
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const client = this.client;
    const iter = (async function* (): AsyncGenerator<MessageStreamEvent, void, void> {
      const body = await client.stream("/v1/messages", {
        method: "POST",
        body: { ...params, compression: params.compression ?? client.defaultCompression },
        signal: controller.signal,
      });
      for await (const msg of parseSSE(body)) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(msg.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = msg.event ?? (typeof parsed.type === "string" ? parsed.type : undefined);
        if (!type) continue;
        if (type === "error") {
          const err = (parsed.error ?? parsed) as { message?: string };
          throw new UnifiedAIError(
            "request_failed",
            `messages stream error: ${err.message ?? "unknown"}`,
            0,
            parsed,
          );
        }
        yield { ...parsed, type } as MessageStreamEvent;
        if (type === "message_stop") return;
      }
    })();
    // Anthropic splits usage across events: input_tokens land on `message_start`,
    // final output_tokens on `message_delta`. Hold input across events and emit
    // the combined usage once both are seen.
    let inputTokens = 0;
    return new MessageStream(iter, controller, (ev) => {
      if (ev.type === "message_start") {
        const u = (
          ev as { message?: { usage?: { input_tokens?: number; output_tokens?: number } } }
        ).message?.usage;
        if (u) inputTokens = u.input_tokens ?? 0;
        return null;
      }
      if (ev.type === "message_delta") {
        const out = (ev as { usage?: { output_tokens?: number } }).usage?.output_tokens ?? 0;
        return {
          input_tokens: inputTokens,
          output_tokens: out,
          total_tokens: inputTokens + out,
        };
      }
      return null;
    });
  }
}
