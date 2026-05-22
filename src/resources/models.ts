import type { Core, RequestOptions } from "../core";

export type ModelType = "text" | "image" | "video" | "audio" | "embedding";

export interface Model {
  id: string;
  type: ModelType;
  object: "model";
  created?: number;
  owned_by: string;
}

export interface ListModelsResponse {
  object: "list";
  data: Model[];
}

export class Models {
  constructor(private readonly client: Core) {}

  list(options: { signal?: AbortSignal } = {}): Promise<ListModelsResponse> {
    const req: RequestOptions = { method: "GET" };
    if (options.signal) req.signal = options.signal;
    return this.client.request<ListModelsResponse>("/api/v1/models", req);
  }
}
