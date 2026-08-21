// Server-backed FsBackend — the default (and only built-in) file transport.
// It implements the `FsBackend` contract by calling unified-api's generic app file store
// (`/api/v1/fs/*`) through the SDK's own request transport, so a signed-in user's
// `sdk.fs` workspace (e.g. an app's project files) is the SAME across devices and
// reachable by any SDK consumer. Default backend whenever the client is
// server-capable and no backend was injected. File bytes cross the wire
// base64-encoded in JSON; responses are object-enveloped.
import { base64ToBytes, bytesToBase64 } from "../../core/_internal/base64";
import type { Core } from "../../core/core";
import type { FsBackend, FsEntry, FsStat, FsWriteReq } from "./types";

export class CloudFsBackend implements FsBackend {
  readonly name = "cloud-fs";

  constructor(private readonly client: Core) {}

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.client.request<T>(`/api/v1/fs${path}`, { method: "POST", body });
  }

  available(): boolean {
    return true;
  }

  async read(ns: string, path: string): Promise<Uint8Array | null> {
    const { blobB64 } = await this.post<{ blobB64: string | null }>("/read", { ns, path });
    return blobB64 ? base64ToBytes(blobB64) : null;
  }

  async write(req: FsWriteReq): Promise<void> {
    await this.post<{ ok: true }>("/write", {
      ns: req.ns,
      path: req.path,
      blobB64: bytesToBase64(req.bytes),
    });
  }

  async list(ns: string, prefix?: string): Promise<FsEntry[]> {
    const { entries } = await this.post<{ entries: FsEntry[] }>("/list", {
      ns,
      prefix: prefix ?? null,
    });
    return entries;
  }

  async stat(ns: string, path: string): Promise<FsStat | null> {
    const { stat } = await this.post<{ stat: FsStat | null }>("/stat", { ns, path });
    return stat;
  }

  async delete(ns: string, path: string): Promise<boolean> {
    const { deleted } = await this.post<{ deleted: boolean }>("/delete", { ns, path });
    return deleted;
  }
}
