import type { Core } from "../core/core.js";
export type EmbeddingInput = string | string[] | number[] | number[][];
export type EmbeddingEncodingFormat = "float" | "base64";
export interface EmbeddingCreateParams {
    model: string;
    input: EmbeddingInput;
    encoding_format?: EmbeddingEncodingFormat;
    dimensions?: number;
    user?: string;
}
export interface Embedding {
    object: "embedding";
    /** Array of floats when `encoding_format` is "float" (default); base64 string when "base64". */
    embedding: number[] | string;
    index: number;
}
export interface EmbeddingUsage {
    prompt_tokens: number;
    total_tokens: number;
}
export interface CreateEmbeddingResponse {
    object: "list";
    data: Embedding[];
    model: string;
    usage: EmbeddingUsage;
}
export interface EmbeddingRequestOptions {
    signal?: AbortSignal;
    /**
     * Opt into the client's in-memory response cache for this call. No-op if
     * the client was constructed without a `cache` option. Cache keys include
     * model, input, and any optional params — changing any of them is a miss.
     */
    cache?: boolean;
}
export interface EmbeddingBatchOptions extends EmbeddingRequestOptions {
    /**
     * Maximum inputs per underlying request. Defaults to 96, which fits inside
     * the lowest documented provider limit (Voyage, Mistral) with headroom.
     * Set higher if you've verified your provider's max-batch is larger.
     */
    batchSize?: number;
}
export declare class Embeddings {
    private readonly client;
    constructor(client: Core);
    create(params: EmbeddingCreateParams, options?: EmbeddingRequestOptions): Promise<CreateEmbeddingResponse>;
    /**
     * Embed an arbitrarily large array of strings by splitting into chunks
     * that fit a single provider request, issuing them in order, and
     * concatenating the results. The returned response preserves global
     * `index` values across chunks and sums `usage`; `model` is taken from
     * the first chunk's response (all chunks must use the same model).
     *
     * Currently only supports `string[]` inputs — passing pre-tokenized
     * `number[][]` would need provider-specific token accounting that we
     * don't have here. Throws if `inputs` is empty.
     */
    createBatch(params: Omit<EmbeddingCreateParams, "input"> & {
        input: string[];
    }, options?: EmbeddingBatchOptions): Promise<CreateEmbeddingResponse>;
}
//# sourceMappingURL=embeddings.d.ts.map