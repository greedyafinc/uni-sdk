// Server-backed StorageBackend — the cloud sibling of the in-memory backend
// (tests only). It implements the same contract by calling unified-api's generic
// app-object store (`/api/v1/storage/*`) through the SDK's own request transport,
// so a signed-in user's `sdk.storage` data is the SAME across devices and is
// reachable by any SDK consumer (first-party host or third-party OAuth app) —
// the SDK only ever talks to unified-api. It is the default backend whenever the
// client is server-capable (a token is configured) and no backend was injected.
//
// Blobs cross the wire base64-encoded inside the JSON body. unified-api stores
// them content-addressed in private Storage and returns them base64 too;
// responses are object-enveloped so a raw blob string never breaks JSON parsing.
import { base64ToBytes, bytesToBase64 } from "../../core/_internal/base64";
import type { Core, RequestOptions } from "../../core/core";
import { throwIfAborted } from "./errors";
import type {
  BackendPage,
  BackendQuery,
  BackendRecord,
  BackendVersion,
  PutReq,
  StorageBackend,
  StorageCallOptions,
  StoredRef,
} from "./types";

export class CloudStorageBackend implements StorageBackend {
  readonly name = "cloud";

  constructor(private readonly client: Core) {}

  private post<T>(path: string, body: unknown, opts?: StorageCallOptions): Promise<T> {
    const req: RequestOptions = { method: "POST", body };
    // `exactOptionalPropertyTypes` rejects assigning a possibly-`undefined`
    // value to an optional property, hence the conditional form rather than
    // `req.signal = opts?.signal`.
    if (opts?.signal) req.signal = opts.signal;
    return this.client.request<T>(`/api/v1/storage${path}`, req);
  }

  available(): boolean {
    return true;
  }

  // The server store is schemaless (rows keyed by ns/collection/id), so there is
  // nothing to provision — skip the round-trip.
  ensureCollection(): Promise<void> {
    return Promise.resolve();
  }

  put(req: PutReq): Promise<StoredRef> {
    return this.post<StoredRef>("/put", {
      ns: req.ns,
      collection: req.collection,
      id: req.id,
      metadata: req.metadata,
      versioned: req.versioned,
      blobB64: req.blob ? bytesToBase64(req.blob) : null,
      blobEncoding: req.blobEncoding ?? null,
    });
  }

  async get(
    ns: string,
    collection: string,
    id: string,
    opts?: StorageCallOptions,
  ): Promise<BackendRecord | null> {
    const { record } = await this.post<{ record: BackendRecord | null }>(
      "/get",
      { ns, collection, id },
      opts,
    );
    return record;
  }

  // `/query-v2` is the SQL-pushed-down path: `where` becomes PostgREST filters
  // and paging is a keyset cursor. The legacy `/query` selected the whole
  // (user, ns, collection) slice and filtered it in JS — it is deliberately no
  // longer called from anywhere in this SDK.
  query(
    ns: string,
    collection: string,
    query: BackendQuery,
    opts?: StorageCallOptions,
  ): Promise<BackendPage> {
    return this.post<BackendPage>("/query-v2", { ns, collection, query }, opts);
  }

  /**
   * `/count-v2` shares `/query-v2`'s exact where-compilation, so every
   * operator (including `match`) counts consistently with `query()` — in a
   * single request. It rejects `limit`/`after` (a page-scoped count would be
   * a wrong answer dressed as a right one), so those are stripped here even
   * though callers shouldn't be passing them for a count.
   */
  async count(
    ns: string,
    collection: string,
    query: BackendQuery,
    opts?: StorageCallOptions,
  ): Promise<number> {
    throwIfAborted(opts?.signal, `count on "${collection}"`);
    const { limit: _limit, after: _after, ...rest } = query;
    const { count } = await this.post<{ count: number }>(
      "/count-v2",
      { ns, collection, query: rest },
      opts,
    );
    return count;
  }

  async delete(ns: string, collection: string, id: string): Promise<boolean> {
    const { deleted } = await this.post<{ deleted: boolean }>("/delete", { ns, collection, id });
    return deleted;
  }

  async readBlob(
    ns: string,
    collection: string,
    id: string,
    opts?: StorageCallOptions,
  ): Promise<Uint8Array | null> {
    const { blobB64 } = await this.post<{ blobB64: string | null }>(
      "/read-blob",
      { ns, collection, id },
      opts,
    );
    return blobB64 ? base64ToBytes(blobB64) : null;
  }

  async listVersions(ns: string, collection: string, id: string): Promise<BackendVersion[]> {
    const { versions } = await this.post<{ versions: BackendVersion[] }>("/list-versions", {
      ns,
      collection,
      id,
    });
    return versions;
  }

  async getVersion(
    ns: string,
    collection: string,
    id: string,
    version: number,
  ): Promise<BackendRecord | null> {
    const { record } = await this.post<{ record: BackendRecord | null }>("/get-version", {
      ns,
      collection,
      id,
      version,
    });
    return record;
  }

  async readVersionBlob(
    ns: string,
    collection: string,
    id: string,
    version: number,
  ): Promise<Uint8Array | null> {
    const { blobB64 } = await this.post<{ blobB64: string | null }>("/read-version-blob", {
      ns,
      collection,
      id,
      version,
    });
    return blobB64 ? base64ToBytes(blobB64) : null;
  }

  revert(ns: string, collection: string, id: string, version: number): Promise<StoredRef> {
    return this.post<StoredRef>("/revert", { ns, collection, id, version });
  }
}
