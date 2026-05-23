import type { Core, RequestOptions } from "../core";

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

export class ChatCompletions {
  constructor(private readonly client: Core) {}

  create(
    params: ChatCompletionCreateParams,
    options: ChatCreateOptions = {},
  ): Promise<ChatCompletionResponse> {
    const req: RequestOptions = { method: "POST", body: params };
    if (options.signal) req.signal = options.signal;
    return this.client.request<ChatCompletionResponse>("/api/v1/chat/completions", req);
  }
}

export class Chat {
  readonly completions: ChatCompletions;
  constructor(client: Core) {
    this.completions = new ChatCompletions(client);
  }
}
