import { parseSSE } from "../core/_internal/sse";
import { UnifiedStream } from "../core/_internal/stream";
import type { Core, RequestOptions } from "../core/core";
import { UnifiedAIError } from "../core/errors";

// ── Content blocks (Anthropic Messages, mirrored from unified-api) ────────────

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
    }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
      is_error?: boolean;
    }
  | { type: "thinking"; thinking: string; signature: string };

export type AnthropicTextBlock = Extract<AnthropicContentBlock, { type: "text" }>;
export type AnthropicImageBlock = Extract<AnthropicContentBlock, { type: "image" }>;

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

export type MessageStream = UnifiedStream<MessageStreamEvent>;

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
    const req: RequestOptions = { method: "POST", body: params };
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
        body: params,
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
    return new UnifiedStream(iter, controller);
  }
}
