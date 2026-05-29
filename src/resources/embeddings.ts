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

const DEFAULT_BATCH_SIZE = 96;

export class Embeddings {
  constructor(private readonly client: Core) {}

  create(
    params: EmbeddingCreateParams,
    options: EmbeddingRequestOptions = {},
  ): Promise<CreateEmbeddingResponse> {
    const req: RequestOptions = { method: "POST", body: params, idempotent: true };
    if (options.signal) req.signal = options.signal;
    if (options.cache) req.cache = true;
    return this.client.request<CreateEmbeddingResponse>("/api/v1/embeddings", req);
  }

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
  async createBatch(
    params: Omit<EmbeddingCreateParams, "input"> & { input: string[] },
    options: EmbeddingBatchOptions = {},
  ): Promise<CreateEmbeddingResponse> {
    const inputs = params.input;
    if (inputs.length === 0) {
      throw new Error("embeddings.createBatch requires a non-empty input array");
    }
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    const data: Embedding[] = [];
    const usage: EmbeddingUsage = { prompt_tokens: 0, total_tokens: 0 };
    let model: string | undefined;
    for (let start = 0; start < inputs.length; start += batchSize) {
      const chunk = inputs.slice(start, start + batchSize);
      const res = await this.create({ ...params, input: chunk }, options);
      if (model === undefined) model = res.model;
      usage.prompt_tokens += res.usage.prompt_tokens;
      usage.total_tokens += res.usage.total_tokens;
      // Re-base provider-local `index` onto the global input position so the
      // caller can pair `data[i].embedding` with `inputs[data[i].index]`.
      for (const item of res.data) {
        data.push({ ...item, index: start + item.index });
      }
    }
    return {
      object: "list",
      data,
      model: model ?? params.model,
      usage,
    };
  }
}
