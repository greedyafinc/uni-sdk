import type { Core } from "../core/core.js";
export type TargetKind = "object" | "file";
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
export declare class Projects {
    private readonly client;
    constructor(client: Core);
    /** Create a project. */
    create(input: CreateProjectInput): Promise<Project>;
    /** List the user's projects (active only unless `archived: true`). */
    list(options?: ListProjectsOptions): Promise<Project[]>;
    /** Fetch one project, or null if it doesn't exist / isn't the user's. */
    get(id: string): Promise<Project | null>;
    /** Patch a project's name/metadata/archived. */
    update(id: string, patch: UpdateProjectInput): Promise<Project>;
    archive(id: string): Promise<Project>;
    unarchive(id: string): Promise<Project>;
    /** Delete a project and all its links. Returns whether a row existed. */
    delete(id: string): Promise<boolean>;
    /** List the artifacts (and portions) attached to a project. */
    links(projectId: string): Promise<ProjectLink[]>;
    /**
     * Attach an artifact to a project. Pass `snapshot` to capture a PORTION (the
     * app extracts the component/snippet bytes itself and supplies them here);
     * omit it to link the whole artifact (resolved live).
     */
    addLink(projectId: string, input: AddLinkInput): Promise<ProjectLink>;
    /** Detach an artifact from a project. Returns whether a row existed. */
    removeLink(projectId: string, linkId: string): Promise<boolean>;
    /** List a project's members (owner or a member may read). */
    members(projectId: string): Promise<Array<{
        userId: string;
        role: string;
    }>>;
    /** Share a project with a user (owner only). */
    addMember(projectId: string, userId: string, role?: string): Promise<{
        projectId: string;
        userId: string;
        role: string;
    }>;
    /** Remove a member (owner only). Returns whether a row existed. */
    removeMember(projectId: string, userId: string): Promise<boolean>;
}
//# sourceMappingURL=projects.d.ts.map