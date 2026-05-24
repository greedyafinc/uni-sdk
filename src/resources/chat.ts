import { parseSSE } from "../core/_internal/sse";
import { UnifiedStream } from "../core/_internal/stream";
import type { Core, RequestOptions } from "../core/core";
import { UnifiedAIError } from "../core/errors";

// ── Request types (OpenAI chat.completions, mirrored from unified-api) ─────────

export type ChatCompletionMessage =
  | ChatCompletionSystemMessage
  | ChatCompletionUserMessage
  | ChatCompletionAssistantMessage
  | ChatCompletionToolMessage;

export interface ChatCompletionSystemMessage {
  role: "system";
  content: string;
  name?: string;
}

export interface ChatCompletionUserMessage {
  role: "user";
  content: string | ChatCompletionUserContentPart[];
  name?: string;
}

export type ChatCompletionUserContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "auto" | "low" | "high" };
    };

export interface ChatCompletionAssistantMessage {
  role: "assistant";
  content?: string | null;
  name?: string;
  tool_calls?: ChatCompletionToolCall[];
}

export interface ChatCompletionToolMessage {
  role: "tool";
  content: string;
  tool_call_id: string;
}

export interface ChatCompletionToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatCompletionToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean;
  };
}

export type ChatCompletionResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        description?: string;
        schema?: unknown;
        strict?: boolean;
      };
    };

export type ChatCompletionToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export interface ChatCompletionCreateParams {
  model: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  n?: number;
  seed?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  tools?: ChatCompletionToolDefinition[];
  tool_choice?: ChatCompletionToolChoice;
  response_format?: ChatCompletionResponseFormat;
  stream_options?: { include_usage?: boolean };
  thinking?: { type: "enabled"; budget_tokens?: number };
  user?: string;
}

// ── Response types ────────────────────────────────────────────────────────────

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
  system_fingerprint?: string | null;
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    reasoning_content?: string | null;
    tool_calls?: ChatCompletionToolCall[];
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  logprobs?: unknown | null;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCreateOptions {
  signal?: AbortSignal;
}

// ── Streaming event types (OpenAI chat.completion.chunk) ──────────────────────

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: ChatCompletionUsage | null;
  system_fingerprint?: string | null;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{
      index: number;
      id?: string;
      type?: "function";
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  logprobs?: unknown | null;
}

export type ChatCompletionStream = UnifiedStream<ChatCompletionChunk>;

export class ChatCompletions {
  constructor(private readonly client: Core) {}

  create(
    params: ChatCompletionCreateParams & { stream: true },
    options?: ChatCreateOptions,
  ): ChatCompletionStream;
  create(
    params: ChatCompletionCreateParams & { stream?: false },
    options?: ChatCreateOptions,
  ): Promise<ChatCompletionResponse>;
  create(
    params: ChatCompletionCreateParams & { stream?: boolean },
    options: ChatCreateOptions = {},
  ): ChatCompletionStream | Promise<ChatCompletionResponse> {
    if (params.stream) {
      return this.createStream(params as ChatCompletionCreateParams & { stream: true }, options);
    }
    const req: RequestOptions = { method: "POST", body: params };
    if (options.signal) req.signal = options.signal;
    return this.client.request<ChatCompletionResponse>("/api/v1/chat/completions", req);
  }

  private createStream(
    params: ChatCompletionCreateParams & { stream: true },
    options: ChatCreateOptions,
  ): ChatCompletionStream {
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const client = this.client;
    const iter = (async function* (): AsyncGenerator<ChatCompletionChunk, void, void> {
      const body = await client.stream("/api/v1/chat/completions", {
        method: "POST",
        body: params,
        signal: controller.signal,
      });
      for await (const msg of parseSSE(body)) {
        if (msg.data === "[DONE]") return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(msg.data);
        } catch {
          continue;
        }
        const obj = parsed as { error?: { message?: string; type?: string } };
        if (obj.error) {
          throw new UnifiedAIError(
            "request_failed",
            `chat.completions stream error: ${obj.error.message ?? "unknown"}`,
            0,
            obj.error,
          );
        }
        yield parsed as ChatCompletionChunk;
      }
    })();
    return new UnifiedStream(iter, controller);
  }
}

export class Chat {
  readonly completions: ChatCompletions;
  constructor(client: Core) {
    this.completions = new ChatCompletions(client);
  }
}
