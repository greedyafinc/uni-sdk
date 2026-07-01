// `sdk.references` — read a project link back into renderable content, including
// ACROSS apps. This is the trusted cross-app read path: resolution is authorized
// by the link's project membership (the user added it), not by a generic
// cross-namespace `sdk.storage` read. A PORTION link returns the immutable
// snapshot captured at link time (with `stale` set when the source has drifted);
// a WHOLE link returns the live artifact. The consuming app interprets
// `fragment` to render the specific component/snippet.
//
// A reference handle is a compact `uniref://<projectId>/<linkId>` URI an app can
// embed inline (a doc link, a design reference card) and resolve later.
import type { Core, RequestOptions } from "../core/core";
import type { TargetKind } from "./projects";

const SCHEME = "uniref://";
const utf8Decoder = new TextDecoder();

function b64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface ReferenceHandle {
  projectId: string;
  linkId: string;
}

/** A resolved reference — content plus the locator the app needs to render it. */
export interface ResolvedReference {
  linkId: string;
  projectId: string;
  targetApp: string;
  targetKind: TargetKind;
  /** App-interpreted portion locator; `{}` means the whole artifact. */
  fragment: Record<string, unknown>;
  artifactType: string;
  label: string | null;
  /** "portion" → snapshot bytes; "whole" → live artifact bytes. */
  kind: "portion" | "whole";
  /** False when a whole-artifact target was deleted out from under the link. */
  found: boolean;
  /** Portion only: the source has changed since the snapshot — offer a resync. */
  stale: boolean;
  /** Target's current updatedAt (whole) or the snapshot capture time (portion). */
  updatedAt: number | null;
  /** Whole-object metadata; null for portions and files. */
  metadata: Record<string, unknown> | null;
  /** Raw blob encoding, when present. */
  encoding: string | null;
  /** Decoded text when the blob is UTF-8; otherwise null (see `bytes`). */
  text: string | null;
  /** Raw bytes when the blob is binary; otherwise null (see `text`). */
  bytes: Uint8Array | null;
}

interface WireResolved {
  linkId: string;
  projectId: string;
  targetApp: string;
  targetKind: TargetKind;
  fragment: Record<string, unknown>;
  artifactType: string;
  label: string | null;
  kind: "portion" | "whole";
  found: boolean;
  stale: boolean;
  updatedAt: number | null;
  metadata: Record<string, unknown> | null;
  blobB64: string | null;
  blobEncoding: string | null;
}

function decode(w: WireResolved): ResolvedReference {
  let text: string | null = null;
  let bytes: Uint8Array | null = null;
  if (w.blobB64 != null) {
    const raw = b64ToBytes(w.blobB64);
    if (w.blobEncoding === "utf8") text = utf8Decoder.decode(raw);
    else bytes = raw;
  }
  return {
    linkId: w.linkId,
    projectId: w.projectId,
    targetApp: w.targetApp,
    targetKind: w.targetKind,
    fragment: w.fragment ?? {},
    artifactType: w.artifactType,
    label: w.label,
    kind: w.kind,
    found: w.found,
    stale: w.stale,
    updatedAt: w.updatedAt,
    metadata: w.metadata,
    encoding: w.blobEncoding,
    text,
    bytes,
  };
}

function linkIdOf(ref: string | ReferenceHandle): string {
  if (typeof ref !== "string") return ref.linkId;
  if (ref.startsWith(SCHEME)) return References.parse(ref).linkId;
  return ref; // a bare linkId
}

export interface ResolveOptions {
  signal?: AbortSignal;
}

export class References {
  constructor(private readonly client: Core) {}

  /** Build a `uniref://<projectId>/<linkId>` handle an app can embed inline. */
  static format(projectId: string, linkId: string): string {
    return `${SCHEME}${projectId}/${linkId}`;
  }

  format(projectId: string, linkId: string): string {
    return References.format(projectId, linkId);
  }

  /** Parse a `uniref://` handle. Throws on a malformed URI. */
  static parse(uri: string): ReferenceHandle {
    if (!uri.startsWith(SCHEME)) {
      throw new Error(`not a reference URI: ${uri}`);
    }
    const [projectId, linkId] = uri.slice(SCHEME.length).split("/");
    if (!projectId || !linkId) throw new Error(`malformed reference URI: ${uri}`);
    return { projectId, linkId };
  }

  parse(uri: string): ReferenceHandle {
    return References.parse(uri);
  }

  /**
   * Resolve a reference (a `uniref://` URI, a {@link ReferenceHandle}, or a bare
   * linkId) into content. For a portion the bytes are the captured snapshot;
   * inspect `stale` to know whether the live source has drifted.
   */
  async resolve(
    ref: string | ReferenceHandle,
    options: ResolveOptions = {},
  ): Promise<ResolvedReference> {
    const linkId = linkIdOf(ref);
    const req: RequestOptions = { method: "GET" };
    if (options.signal) req.signal = options.signal;
    const { reference } = await this.client.request<{ reference: WireResolved }>(
      `/api/v1/references/${encodeURIComponent(linkId)}/resolve`,
      req,
    );
    return decode(reference);
  }

  /**
   * Re-snapshot a portion reference from fresh app-extracted bytes (the app
   * re-runs its own extraction against the live source). Clears `stale`.
   */
  async resync(
    ref: string | ReferenceHandle,
    snapshot: { content: string | Uint8Array | ArrayBuffer; preview?: string },
  ): Promise<ResolvedReference> {
    const linkId = linkIdOf(ref);
    const c = snapshot.content;
    let bytes: Uint8Array;
    let encoding: string;
    if (typeof c === "string") {
      bytes = new TextEncoder().encode(c);
      encoding = "utf8";
    } else if (c instanceof Uint8Array) {
      bytes = c;
      encoding = "binary";
    } else {
      bytes = new Uint8Array(c);
      encoding = "arraybuffer";
    }
    const snapshotB64 =
      typeof Buffer !== "undefined"
        ? Buffer.from(bytes).toString("base64")
        : btoa(String.fromCharCode(...bytes));
    const { reference } = await this.client.request<{ reference: WireResolved }>(
      `/api/v1/references/${encodeURIComponent(linkId)}/resync`,
      {
        method: "POST",
        body: {
          snapshotB64,
          snapshotEncoding: encoding,
          ...(snapshot.preview !== undefined ? { snapshotPreview: snapshot.preview } : {}),
        },
      },
    );
    return decode(reference);
  }
}
