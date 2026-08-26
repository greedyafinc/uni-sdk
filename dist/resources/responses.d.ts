import type { UnifiedStream } from "../core/_internal/stream.js";
import type { Core } from "../core/core.js";
export type ResponseInputContentPart = {
    type: "input_text";
    text: string;
} | {
    type: "input_image";
    image_url?: string;
    /**
     * Stable file id. Accepts both gateway-managed ids from
     * `sdk.files.upload()` / `sdk.files.create()` (resolved server-side
     * to the right transport per routed provider) and provider-native
     * ids (e.g. OpenAI `file-...`). Mutually exclusive with `image_url`.
     */
    file_id?: string;
    detail?: "auto" | "low" | "high";
} | {
    type: "input_audio";
    input_audio: {
        data: string;
        format: "wav" | "mp3";
    };
} | {
    type: "input_video";
    video_url?: string;
    file_data?: string;
    /** See note on {@link ResponseInputContentPart} `input_image.file_id`. */
    file_id?: string;
} | {
    type: "input_file";
    file_data?: string;
    /** See note on {@link ResponseInputContentPart} `input_image.file_id`. */
    file_id?: string;
    file_url?: string;
    filename?: string;
};
export type ResponseInputItem = {
    role: "user";
    content: string | ResponseInputContentPart[];
    type?: "message";
} | {
    role: "assistant";
    content?: string | Array<{
        type: "output_text";
        text: string;
    }> | null;
    type?: "message";
} | {
    role: "system" | "developer";
    content: string;
    type?: "message";
} | {
    type: "function_call";
    call_id: string;
    name: string;
    arguments: string;
} | {
    type: "function_call_output";
    call_id: string;
    output: string | ResponseInputContentPart[];
};
export type ResponseTool = {
    type: "function";
    name: string;
    description?: string;
    parameters?: unknown;
    strict?: boolean;
} | {
    type: "web_search_preview" | "web_search_preview_2025_03_11";
    search_context_size?: "low" | "medium" | "high";
    user_location?: unknown;
} | {
    type: "file_search";
    vector_store_ids: string[];
    filters?: unknown;
    max_num_results?: number;
    ranking_options?: unknown;
} | {
    type: "code_interpreter";
    container?: unknown;
} | {
    type: "computer_use_preview";
    display_width: number;
    display_height: number;
    environment: "mac" | "windows" | "ubuntu" | "browser";
} | {
    type: "mcp";
    server_label: string;
    server_url: string;
    allowed_tools?: "all" | string[];
    headers?: unknown;
    require_approval?: unknown;
};
export type ResponseToolChoice = "none" | "auto" | "required" | {
    type: "function";
    name: string;
};
export interface ResponseCreateParams {
    model: string;
    input: string | ResponseInputItem[];
    instructions?: string;
    tools?: ResponseTool[];
    tool_choice?: ResponseToolChoice;
    temperature?: number;
    max_output_tokens?: number;
    reasoning?: unknown;
    conversation?: string | {
        id: string;
    };
    background?: boolean;
    include?: string[];
    metadata?: unknown;
    store?: boolean;
    top_p?: number;
    truncation?: "auto" | "disabled";
    parallel_tool_calls?: boolean;
    previous_response_id?: string;
    text?: unknown;
    /**
     * Ask the gateway to deterministically compress older conversation context
     * (tool outputs, long prior assistant turns) server-side before routing.
     * Falls back to the client-level `compression` default when unset; an
     * explicit `false` here overrides a client default of `true`.
     */
    compression?: boolean;
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
export type ResponseStreamEvent = {
    type: "response.created";
    response: Partial<ResponseObject> & {
        id: string;
    };
} | {
    type: "response.output_item.added";
    output_index: number;
    item: {
        id?: string;
        type: string;
        role?: string;
        content?: unknown[];
    };
} | {
    type: "response.content_part.added";
    output_index: number;
    content_index: number;
    part: {
        type: string;
        text?: string;
    };
} | {
    type: "response.output_text.delta";
    output_index: number;
    content_index: number;
    delta: string;
} | {
    type: "response.reasoning.delta";
    output_index: number;
    delta: string;
} | {
    type: "response.output_text.done";
    output_index: number;
    content_index: number;
    text: string;
} | {
    type: "response.completed";
    response: ResponseObject;
} | {
    type: "error";
    message: string;
    code?: string;
} | {
    type: string;
    [key: string]: unknown;
};
export type ResponseStream = UnifiedStream<ResponseStreamEvent>;
export declare class Responses {
    private readonly client;
    constructor(client: Core);
    create(params: ResponseCreateParams & {
        stream: true;
    }, options?: ResponseCreateOptions): ResponseStream;
    create(params: ResponseCreateParams & {
        stream?: false;
    }, options?: ResponseCreateOptions): Promise<ResponseObject>;
    private createStream;
}
//# sourceMappingURL=responses.d.ts.map