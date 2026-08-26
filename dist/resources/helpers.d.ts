/**
 * Anything we can turn into binary content + an optional mime type:
 *   - Blob/File          (browser, Node 18+)
 *   - Buffer/Uint8Array  (Node)
 *   - ArrayBuffer
 *   - string             (http(s) URL, data URL, or raw base64 — see `Source`)
 *   - { url }            (hosted URL — used verbatim, no fetch)
 *   - { data, mimeType } (raw base64 string + mime)
 *   - { fileId }         (provider Files-API id, passed through)
 */
export type MultimodalSource = Blob | ArrayBuffer | Uint8Array | {
    url: string;
    mimeType?: string;
} | {
    data: string;
    mimeType: string;
} | {
    fileId: string;
    mimeType?: string;
} | string;
export type AudioFormat = "wav" | "mp3";
export interface PartOptions {
    /** Override the auto-detected mime type. */
    mimeType?: string;
    /** OpenAI image detail hint (chat / responses image parts only). */
    detail?: "auto" | "low" | "high";
    /** Filename hint sent to providers that expose it (responses input_file, chat file). */
    filename?: string;
}
export interface AudioPartOptions extends PartOptions {
    /** Audio format. Required for chat input_audio; auto-detected from mime if omitted. */
    format?: AudioFormat;
}
export type ChatImagePart = {
    type: "image_url";
    image_url: {
        url: string;
        detail?: "auto" | "low" | "high";
    };
};
export type ChatAudioPart = {
    type: "input_audio";
    input_audio: {
        data: string;
        format: AudioFormat;
    };
};
export type ChatVideoPart = {
    type: "video_url";
    video_url: {
        url: string;
    };
};
export type ChatFilePart = {
    type: "file";
    file: {
        file_data?: string;
        file_url?: string;
        file_id?: string;
        filename?: string;
    };
};
export type ResponsesImagePart = {
    type: "input_image";
    image_url?: string;
    file_id?: string;
    detail?: "auto" | "low" | "high";
};
export type ResponsesAudioPart = {
    type: "input_audio";
    input_audio: {
        data: string;
        format: AudioFormat;
    };
};
export type ResponsesVideoPart = {
    type: "input_video";
    video_url?: string;
    file_data?: string;
    file_id?: string;
};
export type ResponsesFilePart = {
    type: "input_file";
    file_data?: string;
    file_url?: string;
    file_id?: string;
    filename?: string;
};
export type MessagesImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export type MessagesImagePart = {
    type: "image";
    source: {
        type: "base64";
        media_type: MessagesImageMediaType;
        data: string;
    };
} | {
    type: "image";
    source: {
        type: "url";
        url: string;
    };
} | {
    type: "image";
    source: {
        type: "file";
        file_id: string;
    };
};
export type MessagesDocumentPart = {
    type: "document";
    source: {
        type: "base64";
        media_type: "application/pdf";
        data: string;
    };
} | {
    type: "document";
    source: {
        type: "url";
        url: string;
    };
} | {
    type: "document";
    source: {
        type: "file";
        file_id: string;
    };
};
export declare function toChatImagePart(source: MultimodalSource, opts?: PartOptions): Promise<ChatImagePart>;
export declare function toChatAudioPart(source: MultimodalSource, opts?: AudioPartOptions): Promise<ChatAudioPart>;
export declare function toChatVideoPart(source: MultimodalSource, opts?: PartOptions): Promise<ChatVideoPart>;
export declare function toChatFilePart(source: MultimodalSource, opts?: PartOptions): Promise<ChatFilePart>;
export declare function toResponsesImagePart(source: MultimodalSource, opts?: PartOptions): Promise<ResponsesImagePart>;
export declare function toResponsesAudioPart(source: MultimodalSource, opts?: AudioPartOptions): Promise<ResponsesAudioPart>;
export declare function toResponsesVideoPart(source: MultimodalSource, opts?: PartOptions): Promise<ResponsesVideoPart>;
export declare function toResponsesFilePart(source: MultimodalSource, opts?: PartOptions): Promise<ResponsesFilePart>;
export declare function toMessagesImagePart(source: MultimodalSource, opts?: PartOptions): Promise<MessagesImagePart>;
export declare function toMessagesDocumentPart(source: MultimodalSource, opts?: PartOptions): Promise<MessagesDocumentPart>;
/**
 * Stateless factory exposed as `sdk.helpers`. All methods delegate to the free
 * functions exported above — keep them in sync. Methods live on the prototype
 * so we don't allocate fresh closures per UnifiedAI instance.
 *
 * `toImagePart` / `toAudioPart` / `toVideoPart` / `toFilePart` default to the
 * chat.completions wire shape; use `toResponses…` / `toMessages…` for the
 * other surfaces.
 */
export declare class Helpers {
    toImagePart(source: MultimodalSource, opts?: PartOptions): Promise<ChatImagePart>;
    toAudioPart(source: MultimodalSource, opts?: AudioPartOptions): Promise<ChatAudioPart>;
    toVideoPart(source: MultimodalSource, opts?: PartOptions): Promise<ChatVideoPart>;
    toFilePart(source: MultimodalSource, opts?: PartOptions): Promise<ChatFilePart>;
    toChatImagePart(source: MultimodalSource, opts?: PartOptions): Promise<ChatImagePart>;
    toChatAudioPart(source: MultimodalSource, opts?: AudioPartOptions): Promise<ChatAudioPart>;
    toChatVideoPart(source: MultimodalSource, opts?: PartOptions): Promise<ChatVideoPart>;
    toChatFilePart(source: MultimodalSource, opts?: PartOptions): Promise<ChatFilePart>;
    toResponsesImagePart(source: MultimodalSource, opts?: PartOptions): Promise<ResponsesImagePart>;
    toResponsesAudioPart(source: MultimodalSource, opts?: AudioPartOptions): Promise<ResponsesAudioPart>;
    toResponsesVideoPart(source: MultimodalSource, opts?: PartOptions): Promise<ResponsesVideoPart>;
    toResponsesFilePart(source: MultimodalSource, opts?: PartOptions): Promise<ResponsesFilePart>;
    toMessagesImagePart(source: MultimodalSource, opts?: PartOptions): Promise<MessagesImagePart>;
    toMessagesDocumentPart(source: MultimodalSource, opts?: PartOptions): Promise<MessagesDocumentPart>;
}
//# sourceMappingURL=helpers.d.ts.map