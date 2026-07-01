// `sdk.projects` — the cross-app project spine. A Project is a user-owned
// container that gathers artifacts produced by different apps (a design from the
// design app, a doc from the docs app, a chat thread, anything stored via
// `sdk.storage`/`sdk.fs`). A ProjectLink records membership and, optionally, a
// PORTION of an artifact.
//
// The platform is portion-AGNOSTIC: for a portion link the calling app supplies
// the extracted snapshot bytes (only the app knows how to extract its own
// component/snippet), and `fragment` is an opaque, app-interpreted locator. See
// `sdk.references` for reading a link back (including cross-app).
import type { Core, RequestOptions } from "../core/core";

export type TargetKind = "object" | "file";
type SnapshotEncoding = "utf8" | "binary" | "arraybuffer";

const utf8Encoder = new TextEncoder();

function bytesToB64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** A user-owned project container. */
export interface Project {
  id: string;
  name: string;
  metadata: Record<string, unknown>;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A membership edge: an artifact (whole, or a portion via `fragment`) in a project. */
export interface ProjectLink {
  id: string;
  projectId: string;
  targetApp: string;
  targetAppId: string | null;
  targetKind: TargetKind;
  collection: string | null;
  objectId: string | null;
  path: string | null;
  /** App-interpreted portion locator; `{}` means the whole artifact. */
  fragment: Record<string, unknown>;
  artifactType: string;
  label: string | null;
  role: string;
  addedByApp: string;
  /** True when a portion snapshot was captured at link time. */
  hasSnapshot: boolean;
  snapshotPreview: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateProjectInput {
  name: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateProjectInput {
  name?: string;
  metadata?: Record<string, unknown>;
  archived?: boolean;
}

/** App-extracted bytes for a portion snapshot. A string is captured as UTF-8. */
export interface SnapshotInput {
  content: string | Uint8Array | ArrayBuffer;
  /** Optional human-readable preview of the captured portion (rendered on a card). */
  preview?: string;
}

export interface AddLinkInput {
  targetApp: string;
  targetAppId?: string | null;
  targetKind: TargetKind;
  /** object kind: the collection + record id in the target app's storage. */
  collection?: string;
  id?: string;
  /** file kind: the file path in the target app's `sdk.fs` workspace. */
  path?: string;
  /** App-interpreted portion locator. Omit (or `{}`) for the whole artifact. */
  fragment?: Record<string, unknown>;
  artifactType: string;
  label?: string;
  role?: string;
  /** Best-effort provenance — which app created the link. */
  addedByApp?: string;
  /** For a PORTION link, the app-extracted bytes to snapshot at link time. */
  snapshot?: SnapshotInput;
}

export interface ListProjectsOptions {
  archived?: boolean;
  signal?: AbortSignal;
}

function encodeSnapshot(s: SnapshotInput): {
  snapshotB64: string;
  snapshotEncoding: SnapshotEncoding;
  snapshotPreview?: string;
} {
  const c = s.content;
  let bytes: Uint8Array;
  let encoding: SnapshotEncoding;
  if (typeof c === "string") {
    bytes = utf8Encoder.encode(c);
    encoding = "utf8";
  } else if (c instanceof Uint8Array) {
    bytes = c;
    encoding = "binary";
  } else {
    bytes = new Uint8Array(c);
    encoding = "arraybuffer";
  }
  return {
    snapshotB64: bytesToB64(bytes),
    snapshotEncoding: encoding,
    ...(s.preview !== undefined ? { snapshotPreview: s.preview } : {}),
  };
}

export class Projects {
  constructor(private readonly client: Core) {}

  /** Create a project. */
  create(input: CreateProjectInput): Promise<Project> {
    return this.client.request<Project>("/api/v1/projects", {
      method: "POST",
      body: { name: input.name, ...(input.metadata ? { metadata: input.metadata } : {}) },
    });
  }

  /** List the user's projects (active only unless `archived: true`). */
  async list(options: ListProjectsOptions = {}): Promise<Project[]> {
    const req: RequestOptions = { method: "GET" };
    if (options.archived) req.query = { archived: "1" };
    if (options.signal) req.signal = options.signal;
    const { projects } = await this.client.request<{ projects: Project[] }>(
      "/api/v1/projects",
      req,
    );
    return projects;
  }

  /** Fetch one project, or null if it doesn't exist / isn't the user's. */
  async get(id: string): Promise<Project | null> {
    const { project } = await this.client.request<{ project: Project | null }>(
      `/api/v1/projects/${encodeURIComponent(id)}`,
      { method: "GET" },
    );
    return project;
  }

  /** Patch a project's name/metadata/archived. */
  update(id: string, patch: UpdateProjectInput): Promise<Project> {
    return this.client.request<Project>(`/api/v1/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
  }

  archive(id: string): Promise<Project> {
    return this.update(id, { archived: true });
  }

  unarchive(id: string): Promise<Project> {
    return this.update(id, { archived: false });
  }

  /** Delete a project and all its links. Returns whether a row existed. */
  async delete(id: string): Promise<boolean> {
    const { deleted } = await this.client.request<{ deleted: boolean }>(
      `/api/v1/projects/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    return deleted;
  }

  /** List the artifacts (and portions) attached to a project. */
  async links(projectId: string): Promise<ProjectLink[]> {
    const { links } = await this.client.request<{ links: ProjectLink[] }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/links`,
      { method: "GET" },
    );
    return links;
  }

  /**
   * Attach an artifact to a project. Pass `snapshot` to capture a PORTION (the
   * app extracts the component/snippet bytes itself and supplies them here);
   * omit it to link the whole artifact (resolved live).
   */
  addLink(projectId: string, input: AddLinkInput): Promise<ProjectLink> {
    const body: Record<string, unknown> = {
      targetApp: input.targetApp,
      targetKind: input.targetKind,
      artifactType: input.artifactType,
    };
    if (input.targetAppId !== undefined) body.targetAppId = input.targetAppId;
    if (input.collection !== undefined) body.collection = input.collection;
    if (input.id !== undefined) body.id = input.id;
    if (input.path !== undefined) body.path = input.path;
    if (input.fragment !== undefined) body.fragment = input.fragment;
    if (input.label !== undefined) body.label = input.label;
    if (input.role !== undefined) body.role = input.role;
    if (input.addedByApp !== undefined) body.addedByApp = input.addedByApp;
    if (input.snapshot) Object.assign(body, encodeSnapshot(input.snapshot));
    return this.client.request<ProjectLink>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/links`,
      { method: "POST", body },
    );
  }

  /** Detach an artifact from a project. Returns whether a row existed. */
  async removeLink(projectId: string, linkId: string): Promise<boolean> {
    const { deleted } = await this.client.request<{ deleted: boolean }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/links/${encodeURIComponent(linkId)}`,
      { method: "DELETE" },
    );
    return deleted;
  }
}
