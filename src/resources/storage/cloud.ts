// Server-backed StorageBackend — the cloud sibling of the local IndexedDB/Memory
// backends. It implements the same contract by calling unified-api's generic
// app-object store (`/api/v1/storage/*`) through the SDK's own request transport,
// so a signed-in user's `sdk.storage` data is the SAME across devices and is
// reachable by any SDK consumer (first-party host or third-party OAuth app) —
// the SDK only ever talks to unified-api. It is the default backend whenever the
// client is server-capable (a token is configured) and no backend was injected.
//
// Blobs cross the wire base64-encoded inside the JSON body. unified-api stores
// them content-addressed in private Storage and returns them base64 too;
// responses are object-enveloped so a raw blob string never breaks JSON parsing.
import type { Core } from "../../core/core";
import type {
  BackendQuery,
  BackendRecord,
  BackendVersion,
  PutReq,
  StorageBackend,
  StoredRef,
} from "./types";

function bytesToB64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class CloudStorageBackend implements StorageBackend {
  readonly name = "cloud";

  constructor(private readonly client: Core) {}

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.client.request<T>(`/api/v1/storage${path}`, { method: "POST", body });
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
      blobB64: req.blob ? bytesToB64(req.blob) : null,
      blobEncoding: req.blobEncoding ?? null,
    });
  }

  async get(ns: string, collection: string, id: string): Promise<BackendRecord | null> {
    const { record } = await this.post<{ record: BackendRecord | null }>("/get", {
      ns,
      collection,
      id,
    });
    return record;
  }

  async query(ns: string, collection: string, query: BackendQuery): Promise<BackendRecord[]> {
    const { records } = await this.post<{ records: BackendRecord[] }>("/query", {
      ns,
      collection,
      query,
    });
    return records;
  }

  async count(ns: string, collection: string, query: BackendQuery): Promise<number> {
    const { count } = await this.post<{ count: number }>("/count", { ns, collection, query });
    return count;
  }

  async delete(ns: string, collection: string, id: string): Promise<boolean> {
    const { deleted } = await this.post<{ deleted: boolean }>("/delete", { ns, collection, id });
    return deleted;
  }

  async readBlob(ns: string, collection: string, id: string): Promise<Uint8Array | null> {
    const { blobB64 } = await this.post<{ blobB64: string | null }>("/read-blob", {
      ns,
      collection,
      id,
    });
    return blobB64 ? b64ToBytes(blobB64) : null;
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
    return blobB64 ? b64ToBytes(blobB64) : null;
  }

  revert(ns: string, collection: string, id: string, version: number): Promise<StoredRef> {
    return this.post<StoredRef>("/revert", { ns, collection, id, version });
  }
}
