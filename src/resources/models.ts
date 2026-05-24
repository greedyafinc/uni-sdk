import type { Core, RequestOptions } from "../core/core";

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
  logo: string | null;
  model_author: ModelAuthor;
  is_custom?: boolean;
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

export class Models {
  constructor(private readonly client: Core) {}

  list(options: ListModelsOptions = {}): Promise<ListModelsResponse> {
    const req: RequestOptions = { method: "GET" };
    if (options.signal) req.signal = options.signal;
    const path = options.include?.length
      ? `/api/v1/models?include=${encodeURIComponent(options.include.join(","))}`
      : "/api/v1/models";
    return this.client.request<ListModelsResponse>(path, req);
  }
}
