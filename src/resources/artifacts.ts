// `sdk.artifacts` — the cross-app export contract (PROTOCOL.md §Artifacts). An
// Artifact is a canonical, self-contained snapshot of an app's work (a design, doc,
// sheet), independent of app-internal state and of whether the producing app is running.
// It is what the main chat, other apps, and external agents (over MCP) consume. Versions
// are whole snapshots; `text` is required (the uniform searchable projection). The
// producing `appId`/`contributedBy` are SERVER-attributed — never sent by the client.
import type { Core, RequestOptions } from "../core/core";
import { NotFoundError } from "../core/errors";

function bytesToB64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** An optional rendered preview (server stores it; fetch a signed URL via `previewUrl`). */
export interface PreviewRef {
  bucket: string;
  path: string;
  mime: string;
}

export interface Artifact {
  id: string;
  projectId: string | null;
  /** Producing app — server-attributed. */
  appId: string;
  /** Open vocabulary, namespaced: "docs/document", "sheets/spreadsheet", … */
  kind: string;
  title: string;
  /** Current version pointer. */
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface ArtifactVersion {
  artifactId: string;
  version: number;
  /** Canonical machine-readable content; per-kind, self-contained JSON. */
  content: unknown;
  /** Required plain-text projection. */
  text: string;
  previewRef: PreviewRef | null;
  /** Client attribution — server-stamped. */
  contributedBy: string;
  createdAt: number;
}

export interface ArtifactWithVersion {
  artifact: Artifact;
  version: ArtifactVersion;
}

/** App-rendered preview bytes; a string is captured UTF-8. */
export interface PreviewInput {
  content: string | Uint8Array | ArrayBuffer;
  mime?: string;
}

export interface CreateArtifactInput {
  projectId?: string | null;
  kind: string;
  title: string;
  content: unknown;
  text: string;
  preview?: PreviewInput;
}

export interface AddVersionInput {
  content: unknown;
  text: string;
  preview?: PreviewInput;
}

export interface ListArtifactsOptions {
  projectId?: string;
  kind?: string;
  signal?: AbortSignal;
}

function encodePreview(p: PreviewInput): { previewB64: string; previewMime?: string } {
  const c = p.content;
  const bytes =
    typeof c === "string" ? new TextEncoder().encode(c) : c instanceof Uint8Array ? c : new Uint8Array(c);
  return { previewB64: bytesToB64(bytes), ...(p.mime !== undefined ? { previewMime: p.mime } : {}) };
}

export class Artifacts {
  constructor(private readonly client: Core) {}

  /** Publish a new artifact (creates version 1). */
  create(input: CreateArtifactInput): Promise<ArtifactWithVersion> {
    const body: Record<string, unknown> = {
      kind: input.kind,
      title: input.title,
      content: input.content,
      text: input.text,
    };
    if (input.projectId !== undefined) body.projectId = input.projectId;
    if (input.preview) Object.assign(body, encodePreview(input.preview));
    return this.client.request<ArtifactWithVersion>("/api/v1/artifacts", { method: "POST", body });
  }

  /** List artifacts, optionally scoped by project and/or kind. */
  async list(options: ListArtifactsOptions = {}): Promise<Artifact[]> {
    const req: RequestOptions = { method: "GET" };
    const query: Record<string, string> = {};
    if (options.projectId) query.projectId = options.projectId;
    if (options.kind) query.kind = options.kind;
    if (Object.keys(query).length) req.query = query;
    if (options.signal) req.signal = options.signal;
    const { artifacts } = await this.client.request<{ artifacts: Artifact[] }>("/api/v1/artifacts", req);
    return artifacts;
  }

  /** Fetch an artifact and its latest version. Throws `NotFoundError` if absent. */
  get(id: string): Promise<{ artifact: Artifact; latest: ArtifactVersion | null }> {
    return this.client.request<{ artifact: Artifact; latest: ArtifactVersion | null }>(
      `/api/v1/artifacts/${encodeURIComponent(id)}`,
      { method: "GET" },
    );
  }

  /** Append a new version (whole snapshot) and bump the pointer. */
  addVersion(id: string, input: AddVersionInput): Promise<ArtifactWithVersion> {
    const body: Record<string, unknown> = { content: input.content, text: input.text };
    if (input.preview) Object.assign(body, encodePreview(input.preview));
    return this.client.request<ArtifactWithVersion>(
      `/api/v1/artifacts/${encodeURIComponent(id)}/versions`,
      { method: "POST", body },
    );
  }

  /** Fetch a specific version, or null if that version doesn't exist. */
  async getVersion(id: string, version: number): Promise<ArtifactVersion | null> {
    try {
      const res = await this.client.request<{ version: ArtifactVersion }>(
        `/api/v1/artifacts/${encodeURIComponent(id)}/versions/${version}`,
        { method: "GET" },
      );
      return res.version;
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  /** A short-lived signed URL to a version's preview, or null when there is none. */
  async previewUrl(id: string, version?: number): Promise<{ url: string; mime: string } | null> {
    try {
      const req: RequestOptions = { method: "GET" };
      if (version !== undefined) req.query = { v: String(version) };
      return await this.client.request<{ url: string; mime: string }>(
        `/api/v1/artifacts/${encodeURIComponent(id)}/preview`,
        req,
      );
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  /**
   * Resolve a chat/cross-app reference `artifact://<id>[@<version>]` to its artifact +
   * version. Returns null if the ref is malformed or the target is gone.
   */
  async resolveRef(ref: string): Promise<ArtifactWithVersion | null> {
    const m = /^artifact:\/\/([^@/]+)(?:@(\d+))?$/.exec(ref.trim());
    if (!m || !m[1]) return null;
    let id: string;
    try {
      id = decodeURIComponent(m[1]); // malformed percent-escape (e.g. `artifact://ab%`) → null, not a throw
    } catch {
      return null;
    }
    try {
      if (m[2]) {
        const version = await this.getVersion(id, Number(m[2]));
        if (!version) return null;
        const { artifact } = await this.get(id);
        return { artifact, version };
      }
      const { artifact, latest } = await this.get(id);
      return latest ? { artifact, version: latest } : null;
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }
}
