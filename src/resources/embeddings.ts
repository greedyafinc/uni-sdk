import type { Core, RequestOptions } from "../core/core";

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
}

export class Embeddings {
  constructor(private readonly client: Core) {}

  create(
    params: EmbeddingCreateParams,
    options: EmbeddingRequestOptions = {},
  ): Promise<CreateEmbeddingResponse> {
    const req: RequestOptions = { method: "POST", body: params };
    if (options.signal) req.signal = options.signal;
    return this.client.request<CreateEmbeddingResponse>("/api/v1/embeddings", req);
  }
}
