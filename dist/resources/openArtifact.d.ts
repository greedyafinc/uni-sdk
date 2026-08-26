import type { ProjectLink } from "./projects.js";
import type { SearchHit } from "./search/types.js";
/** The action id every app that can surface an artifact declares. */
export declare const OPEN_ARTIFACT_ACTION = "openArtifact";
/**
 * A pointer to one artifact in one app, from any surface. `objectId` or `path`
 * identifies it (objects and files respectively); everything else is a hint the
 * target app may use or ignore.
 */
export interface ArtifactRef {
    /** Owning app id, e.g. "design" | "sheets" | "docs" | "notes" | "planner". */
    app: string;
    /** App-local object id. Null only for file-backed artifacts, which use `path`. */
    objectId?: string | null;
    /** Storage path, for file-backed artifacts. */
    path?: string | null;
    /** App-local collection/namespace the object lives in. */
    collection?: string | null;
    /** Owning project, when the caller knows it — lets the shell scope the app. */
    projectId?: string | null;
    /**
     * The app's own artifact kind ("issue", "note", "design"…). Apps that route
     * differently per kind need this; a search hit's `kind` and a link's
     * `artifactType` both land here.
     */
    kind?: string | null;
    /**
     * App-interpreted portion locator — the same opaque shape `ProjectLink.fragment`
     * and `ResolvedReference.fragment` carry. `{}` (or absent) means the whole
     * artifact. Sheets reads a worksheet/range out of it; most apps ignore it.
     */
    fragment?: Record<string, unknown>;
    /** Human label, for error messages only. Never used for resolution. */
    label?: string | null;
    /**
     * Override: invoke this action instead of `openArtifact`. Only for callers
     * that hold richer intent than the standard params express (a search hit
     * pointing at a specific cell range). Must be a declared, non-mutating action
     * of the SAME app — shells reject anything else.
     */
    action?: string;
    /** Params for `action`. Ignored unless `action` is set. */
    params?: Record<string, unknown>;
}
/** What an app's `openArtifact` handler actually receives. */
export interface OpenArtifactParams {
    objectId?: string;
    path?: string;
    collection?: string;
    kind?: string;
    fragment?: Record<string, unknown>;
}
/**
 * What an open attempt achieved. Only "item" means the artifact is on screen —
 * a caller that reports anything else as success is telling the user to look at
 * something that isn't there.
 */
export type OpenArtifactOutcome = 
/** The artifact itself was surfaced. */
{
    kind: "item";
}
/** The app is on screen but the artifact is not — it declares no open path. */
 | {
    kind: "app";
    reason: string;
}
/** Nothing was opened: unknown app, or the app refused. */
 | {
    kind: "unavailable";
    reason: string;
};
/** JSON Schema for `openArtifact`'s params. Apps MUST declare exactly this. */
export declare const OPEN_ARTIFACT_PARAMS_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly objectId: {
            readonly type: "string";
            readonly description: "App-local id of the artifact to open.";
        };
        readonly path: {
            readonly type: "string";
            readonly description: "Storage path, for file-backed artifacts that have no object id.";
        };
        readonly collection: {
            readonly type: "string";
            readonly description: "App-local collection the object lives in, when the caller knows it.";
        };
        readonly kind: {
            readonly type: "string";
            readonly description: "The app's own artifact kind, for apps that route differently per kind.";
        };
        readonly fragment: {
            readonly type: "object";
            readonly additionalProperties: true;
            readonly description: "App-interpreted portion locator (the ProjectLink/reference `fragment`). Absent or {} means the whole artifact.";
        };
    };
};
/**
 * The canonical manifest entry. Every app that can surface an artifact declares
 * this VERBATIM — shells assert deep equality against it, so an app cannot drift
 * the param shape or forget `mutates: false` (which is fail-closed: an action
 * that omits it is treated as a write and silently refused on read-only paths).
 *
 * `exposeToMcp` is false by design. This is shell plumbing; the model keeps the
 * app's own richly-described open actions.
 */
export declare const OPEN_ARTIFACT_SPEC: {
    readonly id: "openArtifact";
    readonly title: "Open an artifact";
    readonly description: "Bring one of this app's artifacts on screen. Invoked by the shell when the user follows a cross-app pointer — a search result, an @-mention, a project link, a reference. Not intended for agent use; the app's own open actions are the model-facing ones.";
    readonly params: {
        readonly type: "object";
        readonly additionalProperties: false;
        readonly properties: {
            readonly objectId: {
                readonly type: "string";
                readonly description: "App-local id of the artifact to open.";
            };
            readonly path: {
                readonly type: "string";
                readonly description: "Storage path, for file-backed artifacts that have no object id.";
            };
            readonly collection: {
                readonly type: "string";
                readonly description: "App-local collection the object lives in, when the caller knows it.";
            };
            readonly kind: {
                readonly type: "string";
                readonly description: "The app's own artifact kind, for apps that route differently per kind.";
            };
            readonly fragment: {
                readonly type: "object";
                readonly additionalProperties: true;
                readonly description: "App-interpreted portion locator (the ProjectLink/reference `fragment`). Absent or {} means the whole artifact.";
            };
        };
    };
    readonly tier: "safe";
    readonly mutates: false;
    readonly exposeToMcp: false;
};
/** Narrow an ArtifactRef to the params its app's handler receives. */
export declare function toOpenArtifactParams(ref: ArtifactRef): OpenArtifactParams;
/** True when a ref identifies something — the shell can skip a doomed invoke. */
export declare function isResolvableArtifactRef(ref: ArtifactRef): boolean;
/** A project link → the ref that opens it. */
export declare function artifactRefFromLink(link: ProjectLink): ArtifactRef;
/**
 * A search hit → the ref that opens it. `app` is the host-stamped owning app
 * (hits never carry it themselves). A hit's `openRef.action` becomes the
 * override, so an app can still point one hit at a richer action.
 */
export declare function artifactRefFromHit(app: string, hit: SearchHit): ArtifactRef;
//# sourceMappingURL=openArtifact.d.ts.map