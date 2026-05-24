import { parseSSE } from "../core/_internal/sse";
import { UnifiedStream } from "../core/_internal/stream";
import type { Core, RequestOptions } from "../core/core";
import { UnifiedAIError } from "../core/errors";

// ── Input content parts (OpenAI Responses, mirrored from unified-api) ─────────

export type ResponseInputContentPart =
  | { type: "input_text"; text: string }
  | {
      type: "input_image";
      image_url?: string;
      file_id?: string;
      detail?: "auto" | "low" | "high";
    }
  | {
      type: "input_file";
      file_id?: string;
      file_url?: string;
      filename?: string;
    };

export type ResponseInputItem =
  | {
      role: "user";
      content: string | ResponseInputContentPart[];
      type?: "message";
    }
  | {
      role: "assistant";
      content?: string | Array<{ type: "output_text"; text: string }> | null;
      type?: "message";
    }
  | {
      role: "system" | "developer";
      content: string;
      type?: "message";
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string | ResponseInputContentPart[];
    };

export type ResponseTool =
  | {
      type: "function";
      name: string;
      description?: string;
      parameters?: unknown;
      strict?: boolean;
    }
  | {
      type: "web_search_preview" | "web_search_preview_2025_03_11";
      search_context_size?: "low" | "medium" | "high";
      user_location?: unknown;
    }
  | {
      type: "file_search";
      vector_store_ids: string[];
      filters?: unknown;
      max_num_results?: number;
      ranking_options?: unknown;
    }
  | { type: "code_interpreter"; container?: unknown }
  | {
      type: "computer_use_preview";
      display_width: number;
      display_height: number;
      environment: "mac" | "windows" | "ubuntu" | "browser";
    }
  | {
      type: "mcp";
      server_label: string;
      server_url: string;
      allowed_tools?: "all" | string[];
      headers?: unknown;
      require_approval?: unknown;
    };

export type ResponseToolChoice = "none" | "auto" | "required" | { type: "function"; name: string };

export interface ResponseCreateParams {
  model: string;
  input: string | ResponseInputItem[];
  instructions?: string;
  tools?: ResponseTool[];
  tool_choice?: ResponseToolChoice;
  temperature?: number;
  max_output_tokens?: number;
  reasoning?: unknown;
  conversation?: string | { id: string };
  background?: boolean;
  include?: string[];
  metadata?: unknown;
  store?: boolean;
  top_p?: number;
  truncation?: "auto" | "disabled";
  parallel_tool_calls?: boolean;
  previous_response_id?: string;
  text?: unknown;
  user?: string;
}

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  output: unknown[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  status: "completed" | "incomplete" | "failed" | "in_progress";
}

export interface ResponseCreateOptions {
  signal?: AbortSignal;
}

// ── Streaming event types (OpenAI Responses) ──────────────────────────────────
// Event names match unified-api/src/modules/responses/service.ts.

export type ResponseStreamEvent =
  | { type: "response.created"; response: Partial<ResponseObject> & { id: string } }
  | {
      type: "response.output_item.added";
      output_index: number;
      item: { id?: string; type: string; role?: string; content?: unknown[] };
    }
  | {
      type: "response.content_part.added";
      output_index: number;
      content_index: number;
      part: { type: string; text?: string };
    }
  | {
      type: "response.output_text.delta";
      output_index: number;
      content_index: number;
      delta: string;
    }
  | {
      type: "response.reasoning.delta";
      output_index: number;
      delta: string;
    }
  | {
      type: "response.output_text.done";
      output_index: number;
      content_index: number;
      text: string;
    }
  | { type: "response.completed"; response: ResponseObject }
  | { type: "error"; message: string; code?: string }
  | { type: string; [key: string]: unknown };

export type ResponseStream = UnifiedStream<ResponseStreamEvent>;

export class Responses {
  constructor(private readonly client: Core) {}

  create(
    params: ResponseCreateParams & { stream: true },
    options?: ResponseCreateOptions,
  ): ResponseStream;
  create(
    params: ResponseCreateParams & { stream?: false },
    options?: ResponseCreateOptions,
  ): Promise<ResponseObject>;
  create(
    params: ResponseCreateParams & { stream?: boolean },
    options: ResponseCreateOptions = {},
  ): ResponseStream | Promise<ResponseObject> {
    if (params.stream) {
      return this.createStream(params as ResponseCreateParams & { stream: true }, options);
    }
    const req: RequestOptions = { method: "POST", body: params };
    if (options.signal) req.signal = options.signal;
    return this.client.request<ResponseObject>("/api/v1/responses", req);
  }

  private createStream(
    params: ResponseCreateParams & { stream: true },
    options: ResponseCreateOptions,
  ): ResponseStream {
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const client = this.client;
    const iter = (async function* (): AsyncGenerator<ResponseStreamEvent, void, void> {
      const body = await client.stream("/api/v1/responses", {
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
          // unified-api emits `{type:"error", error:{message, type}}`; accept either
          // shape so we surface the real upstream message instead of a generic fallback.
          const err = (parsed.error ?? parsed) as { message?: string };
          const m = typeof err.message === "string" ? err.message : "unknown";
          throw new UnifiedAIError("request_failed", `responses stream error: ${m}`, 0, parsed);
        }
        yield { ...parsed, type } as ResponseStreamEvent;
        if (type === "response.completed") return;
      }
    })();
    return new UnifiedStream(iter, controller);
  }
}
