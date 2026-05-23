import type { Core, RequestOptions } from "../core";

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

export class Messages {
  constructor(private readonly client: Core) {}

  create(
    params: MessageCreateParams,
    options: MessageCreateOptions = {},
  ): Promise<AnthropicMessageResponse> {
    const req: RequestOptions = { method: "POST", body: params };
    if (options.signal) req.signal = options.signal;
    return this.client.request<AnthropicMessageResponse>("/v1/messages", req);
  }
}
