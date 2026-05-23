import type { Core, RequestOptions } from "../core";

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

export class Responses {
  constructor(private readonly client: Core) {}

  create(
    params: ResponseCreateParams,
    options: ResponseCreateOptions = {},
  ): Promise<ResponseObject> {
    const req: RequestOptions = { method: "POST", body: params };
    if (options.signal) req.signal = options.signal;
    return this.client.request<ResponseObject>("/api/v1/responses", req);
  }
}
