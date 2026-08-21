import type { Core, RequestOptions } from "../core/core";
import { UnifiedError } from "../core/errors";

export interface MeUser {
  readonly id: string;
  readonly email: string | null;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly display_name: string | null;
  readonly created_at: string;
  readonly account_type: number;
}

export interface MeClient {
  /** OAuth client id, or `null` when the caller authenticated with a non-OAuth credential (e.g. a `uapi_` key). */
  readonly id: string | null;
  readonly app_name: string;
}

export interface MeResponse {
  readonly user: MeUser;
  readonly client: MeClient;
}

export interface GetMeOptions {
  readonly signal?: AbortSignal;
}

/** Options for {@link Users.get} — same shape as {@link GetMeOptions}, aliased for read-site clarity. */
export type GetUserOptions = GetMeOptions;

export interface PublicUser {
  readonly id: string;
  readonly first_name: string | null;
  readonly last_name: string | null;
  readonly display_name: string | null;
  readonly created_at: string;
}

export interface PublicUserResponse {
  readonly user: PublicUser;
}

export interface PublicUsersResponse {
  readonly users: readonly PublicUser[];
}

/** Gateway-enforced cap on `ids` for {@link Users.list} (after client-side dedupe). */
const MAX_LIST_IDS = 100;

export class Users {
  constructor(private readonly client: Core) {}

  /**
   * Resolve the authenticated user's profile from the gateway. Works with any
   * accepted credential type (OAuth access token, app token, or `uapi_` key) —
   * the response's `client` describes which app/credential made the call.
   * `email` may be `null` when the provider didn't supply one.
   */
  me(options: GetMeOptions = {}): Promise<MeResponse> {
    const req: RequestOptions = { method: "GET" };
    if (options.signal) req.signal = options.signal;
    return this.client.request<MeResponse>("/api/v1/me", req);
  }

  /**
   * Resolve any user id to their public display info — e.g. rendering project
   * member names in a shared workspace. Any authenticated caller can look up
   * any id, so the response never includes `email` or `account_type`; those
   * stay exclusive to {@link me}. Rejects with a `NotFoundError` (`code:
   * "not_found"`) for an unknown id.
   */
  get(id: string, options: GetUserOptions = {}): Promise<PublicUserResponse> {
    const req: RequestOptions = { method: "GET" };
    if (options.signal) req.signal = options.signal;
    return this.client.request<PublicUserResponse>(`/api/v1/users/${encodeURIComponent(id)}`, req);
  }

  /**
   * Batch-resolve public display info for multiple user ids in one round
   * trip — e.g. rendering a list of project members without N+1 calls to
   * {@link get}. Found-only: unknown or malformed ids are silently omitted
   * from the response rather than erroring, so callers should treat an
   * absent id as "unknown user" (order of the returned `users` is
   * unspecified). Same field set as {@link get} — no `email`/`account_type`.
   *
   * Ids are trimmed, empties dropped, and duplicates deduped client-side
   * before the request; no SDK-side caching is applied — every call hits the
   * network. An empty result after dedupe resolves `{ users: [] }` without a
   * request. More than 100 deduped ids throws (matching the
   * gateway's cap) rather than silently truncating — chunk the request
   * yourself if you need to look up more.
   */
  async list(ids: readonly string[], options: GetUserOptions = {}): Promise<PublicUsersResponse> {
    const deduped = Array.from(new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0)));
    if (deduped.length === 0) return { users: [] };
    if (deduped.length > MAX_LIST_IDS) {
      throw new UnifiedError(
        "invalid_input",
        `users.list accepts at most ${MAX_LIST_IDS} ids, got ${deduped.length}`,
      );
    }
    const req: RequestOptions = { method: "GET", query: { ids: deduped.join(",") } };
    if (options.signal) req.signal = options.signal;
    return this.client.request<PublicUsersResponse>("/api/v1/users", req);
  }
}
