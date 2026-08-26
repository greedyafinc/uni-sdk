import { UnifiedStream } from "../core/_internal/stream.js";
import type { Core } from "../core/core.js";
export type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export type AnthropicImageSource = {
    type: "base64";
    media_type: AnthropicImageMediaType;
    data: string;
} | {
    type: "url";
    url: string;
} | {
    type: "file";
    file_id: string;
};
export type AnthropicDocumentSource = {
    type: "base64";
    media_type: "application/pdf";
    data: string;
} | {
    type: "url";
    url: string;
} | {
    type: "file";
    file_id: string;
};
export type AnthropicContentBlock = {
    type: "text";
    text: string;
} | {
    type: "image";
    source: AnthropicImageSource;
} | {
    type: "document";
    source: AnthropicDocumentSource;
} | {
    type: "tool_use";
    id: string;
    name: string;
    input: unknown;
} | {
    type: "tool_result";
    tool_use_id: string;
    content?: string | Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock>;
    is_error?: boolean;
} | {
    type: "thinking";
    thinking: string;
    signature: string;
};
export type AnthropicTextBlock = Extract<AnthropicContentBlock, {
    type: "text";
}>;
export type AnthropicImageBlock = Extract<AnthropicContentBlock, {
    type: "image";
}>;
export type AnthropicDocumentBlock = Extract<AnthropicContentBlock, {
    type: "document";
}>;
export interface AnthropicMessage {
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
}
export interface AnthropicToolDefinition {
    name: string;
    description: string;
    input_schema: unknown;
}
export type AnthropicToolChoice = {
    type: "auto";
} | {
    type: "any";
} | {
    type: "tool";
    name: string;
};
export interface MessageCreateParams {
    model: string;
    messages: AnthropicMessage[];
    max_tokens: number;
    system?: string | Array<{
        type: "text";
        text: string;
    }>;
    metadata?: {
        user_id?: string;
    };
    stop_sequences?: string[];
    temperature?: number;
    top_p?: number;
    top_k?: number;
    tools?: AnthropicToolDefinition[];
    tool_choice?: AnthropicToolChoice;
    thinking?: {
        type: "enabled";
        budget_tokens: number;
    };
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
    usage: {
        input_tokens: number;
        output_tokens: number;
    };
}
export interface MessageCreateOptions {
    signal?: AbortSignal;
}
export type MessageStreamEvent = {
    type: "message_start";
    message: Omit<AnthropicMessageResponse, "content" | "stop_reason" | "stop_sequence"> & {
        content: AnthropicContentBlock[];
        stop_reason: AnthropicMessageResponse["stop_reason"];
        stop_sequence?: string | null;
    };
} | {
    type: "content_block_start";
    index: number;
    content_block: AnthropicContentBlock;
} | {
    type: "content_block_delta";
    index: number;
    delta: {
        type: "text_delta";
        text: string;
    } | {
        type: "input_json_delta";
        partial_json: string;
    } | {
        type: "thinking_delta";
        thinking: string;
    } | {
        type: "signature_delta";
        signature: string;
    };
} | {
    type: "content_block_stop";
    index: number;
} | {
    type: "message_delta";
    delta: {
        stop_reason?: AnthropicMessageResponse["stop_reason"];
        stop_sequence?: string | null;
    };
    usage?: {
        output_tokens?: number;
    };
} | {
    type: "message_stop";
} | {
    type: "ping";
} | {
    type: "error";
    error: {
        type: string;
        message: string;
    };
};
export declare class MessageStream extends UnifiedStream<MessageStreamEvent> {
    private finalPromise;
    finalMessage(): Promise<AnthropicMessageResponse>;
}
export declare class Messages {
    private readonly client;
    constructor(client: Core);
    create(params: MessageCreateParams & {
        stream: true;
    }, options?: MessageCreateOptions): MessageStream;
    create(params: MessageCreateParams & {
        stream?: false;
    }, options?: MessageCreateOptions): Promise<AnthropicMessageResponse>;
    private createStream;
}
//# sourceMappingURL=messages.d.ts.map