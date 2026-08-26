import type { Core } from "../core/core.js";
export type ModelType = "text" | "image" | "video" | "audio" | "embedding";
export interface ModelAuthor {
    name: string;
    color?: string | null;
}
export interface Model {
    id: string;
    name: string;
    type: ModelType;
    object: "model";
    created?: number;
    owned_by: string;
    image_inp?: boolean;
    audio_inp?: boolean;
    video_inp?: boolean;
    pdf_inp?: boolean;
    logo: string | null;
    model_author: ModelAuthor;
    is_custom?: boolean;
    /**
     * The model's context window in tokens, from the gateway's catalog. Null or
     * absent when unknown (the `auto` router, custom backends, older gateways).
     */
    context_size?: number | null;
}
export interface ListModelsResponse {
    object: "list";
    data: Model[];
}
export interface ListModelsOptions {
    signal?: AbortSignal;
    /** Optional expansions to include in each model entry. */
    include?: Array<"author">;
}
export declare class Models {
    private readonly client;
    constructor(client: Core);
    list(options?: ListModelsOptions): Promise<ListModelsResponse>;
}
//# sourceMappingURL=models.d.ts.map