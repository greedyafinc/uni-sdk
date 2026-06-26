// Server-backed FsBackend — the cloud sibling of the local OPFS backend. It
// implements the same contract by calling unified-api's generic app file store
// (`/api/v1/fs/*`) through the SDK's own request transport, so a signed-in user's
// `sdk.fs` workspace (e.g. an app's project files) is the SAME across devices and
// reachable by any SDK consumer. Default backend whenever the client is
// server-capable and no backend was injected. File bytes cross the wire
// base64-encoded in JSON; responses are object-enveloped.
import type { Core } from "../../core/core";
import type { FsBackend, FsEntry, FsStat, FsWriteReq } from "./types";

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
    return blobB64 ? b64ToBytes(blobB64) : null;
  }

  async write(req: FsWriteReq): Promise<void> {
    await this.post<{ ok: true }>("/write", {
      ns: req.ns,
      path: req.path,
      blobB64: bytesToB64(req.bytes),
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
