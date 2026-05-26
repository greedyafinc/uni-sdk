import { UnifiedError } from "./errors";

export type TokenProvider = string | (() => string | Promise<string>);

export interface CoreOptions {
  /**
   * Trusted-token mode. When set, the SDK bypasses OAuth/PKCE/handoff/keychain
   * and uses the supplied bearer token for every request. Pass a function to
   * have the host resolve a fresh token per request (e.g. read from an auth
   * store). On 401, the SDK re-invokes the provider once to give the host a
   * chance to refresh; if the retry still 401s, the call fails.
   *
   * Intended for first-party apps that already manage their own auth lifecycle.
   * External integrations should leave this unset and use the OAuth flow.
   */
  token?: TokenProvider;
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
  /**
   * Allowlist of acceptable response Content-Type values for `requestBinary`.
   * Matches by exact MIME (e.g. "video/mp4") or by `<type>/` prefix (e.g.
   * "audio/" matches any audio/* subtype). When set, a 200 with a
   * content-type outside this list is rejected with a `UnifiedAIError`
   * instead of being silently returned as bytes — defense against gateway
   * error pages and provider misconfiguration. Ignored by `request`/`stream`.
   */
  acceptedContentTypes?: readonly string[];
}

export class Core {
  protected readonly options: Readonly<Required<Omit<CoreOptions, "token">>> & {
    token: TokenProvider | undefined;
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

  async requestBinary(
    _path: string,
    _options: RequestOptions = {},
  ): Promise<{
    bytes: ArrayBuffer;
    contentType: string;
    headers: Readonly<Record<string, string>>;
  }> {
    throw new UnifiedError("not_implemented", "Core.requestBinary is not wired up yet");
  }

  async stream(_path: string, _options: RequestOptions = {}): Promise<ReadableStream<Uint8Array>> {
    throw new UnifiedError("not_implemented", "Core.stream is not wired up yet");
  }
}
