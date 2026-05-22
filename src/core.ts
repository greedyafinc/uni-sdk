import { UnifiedError } from "./errors";

export interface CoreOptions {
  token?: string;
  apiUrl?: string;
  workspaceId?: string;
  appId?: string;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

export class Core {
  protected readonly options: Readonly<Required<Omit<CoreOptions, "token">>> & {
    token: string | undefined;
  };

  constructor(options: CoreOptions = {}) {
    this.options = Object.freeze({
      token: options.token,
      apiUrl: options.apiUrl ?? "",
      workspaceId: options.workspaceId ?? "",
      appId: options.appId ?? "",
      fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    });
  }

  async request<T>(_path: string, _options: RequestOptions = {}): Promise<T> {
    throw new UnifiedError("not_implemented", "Core.request is not wired up yet");
  }
}
