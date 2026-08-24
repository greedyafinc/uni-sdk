// The cross-app OPEN contract: one verb every app implements so any surface can
// put any artifact on screen without knowing that app's routing.
//
// Why one verb instead of per-app action names. A caller that holds a pointer to
// someone else's artifact generally CANNOT know which action opens it:
//
//   - A `ProjectLink` (sdk.projects) is stored data, written by a different app,
//     possibly before the target app declared any actions at all.
//   - A reference handle (`uniref://…`, sdk.references) is the same, embedded in
//     a doc or a comment and resolved much later.
//   - A search hit CAN name an action, because the owning app authors the hit at
//     query time — but that makes search the only surface that works, and every
//     other caller needs an N-app mapping table in the shell.
//
// So the app declares `openArtifact` once, and every surface — cross-app search,
// @-mentions, project pages, chat citations, notifications, external agents —
// calls the same thing. Apps keep their richer, model-facing open actions
// (`openSheet` with a worksheet + range, `openDesign` with a project) for callers
// that have more to say; `openArtifact` is the floor, not a replacement, and a
// ref may name one of those richer actions via `action`/`params` as an override.
//
// Types and pure adapters only — no Core, no requests. The registration runtime
// is the shell's (`registerActions` in the host bridge), not the gateway's.
import type { ProjectLink } from "./projects";
import type { SearchHit } from "./search/types";

/** The action id every app that can surface an artifact declares. */
export const OPEN_ARTIFACT_ACTION = "openArtifact";

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
  | { kind: "item" }
  /** The app is on screen but the artifact is not — it declares no open path. */
  | { kind: "app"; reason: string }
  /** Nothing was opened: unknown app, or the app refused. */
  | { kind: "unavailable"; reason: string };

/** JSON Schema for `openArtifact`'s params. Apps MUST declare exactly this. */
export const OPEN_ARTIFACT_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    objectId: {
      type: "string",
      description: "App-local id of the artifact to open.",
    },
    path: {
      type: "string",
      description: "Storage path, for file-backed artifacts that have no object id.",
    },
    collection: {
      type: "string",
      description: "App-local collection the object lives in, when the caller knows it.",
    },
    kind: {
      type: "string",
      description: "The app's own artifact kind, for apps that route differently per kind.",
    },
    fragment: {
      type: "object",
      additionalProperties: true,
      description:
        "App-interpreted portion locator (the ProjectLink/reference `fragment`). Absent or {} means the whole artifact.",
    },
  },
} as const;

/**
 * The canonical manifest entry. Every app that can surface an artifact declares
 * this VERBATIM — shells assert deep equality against it, so an app cannot drift
 * the param shape or forget `mutates: false` (which is fail-closed: an action
 * that omits it is treated as a write and silently refused on read-only paths).
 *
 * `exposeToMcp` is false by design. This is shell plumbing; the model keeps the
 * app's own richly-described open actions.
 */
export const OPEN_ARTIFACT_SPEC = {
  id: OPEN_ARTIFACT_ACTION,
  title: "Open an artifact",
  description:
    "Bring one of this app's artifacts on screen. Invoked by the shell when the user follows a cross-app pointer — a search result, an @-mention, a project link, a reference. Not intended for agent use; the app's own open actions are the model-facing ones.",
  params: OPEN_ARTIFACT_PARAMS_SCHEMA,
  tier: "safe",
  mutates: false,
  exposeToMcp: false,
} as const;

function cleanFragment(
  fragment: Record<string, unknown> | undefined | null,
): Record<string, unknown> | undefined {
  if (!fragment || typeof fragment !== "object") return undefined;
  return Object.keys(fragment).length > 0 ? fragment : undefined;
}

/** Narrow an ArtifactRef to the params its app's handler receives. */
export function toOpenArtifactParams(ref: ArtifactRef): OpenArtifactParams {
  const out: OpenArtifactParams = {};
  if (ref.objectId) out.objectId = ref.objectId;
  if (ref.path) out.path = ref.path;
  if (ref.collection) out.collection = ref.collection;
  if (ref.kind) out.kind = ref.kind;
  const fragment = cleanFragment(ref.fragment);
  if (fragment) out.fragment = fragment;
  return out;
}

/** True when a ref identifies something — the shell can skip a doomed invoke. */
export function isResolvableArtifactRef(ref: ArtifactRef): boolean {
  return Boolean(ref.app && (ref.objectId || ref.path));
}

/** A project link → the ref that opens it. */
export function artifactRefFromLink(link: ProjectLink): ArtifactRef {
  const fragment = cleanFragment(link.fragment);
  return {
    app: link.targetApp,
    objectId: link.objectId,
    path: link.path,
    collection: link.collection,
    projectId: link.projectId,
    kind: link.artifactType,
    label: link.label,
    // Spread, not `fragment: undefined` — under exactOptionalPropertyTypes an
    // explicit undefined is not the same as absent, and absent is what "whole
    // artifact" means.
    ...(fragment ? { fragment } : {}),
  };
}

/**
 * A search hit → the ref that opens it. `app` is the host-stamped owning app
 * (hits never carry it themselves). A hit's `openRef.action` becomes the
 * override, so an app can still point one hit at a richer action.
 */
export function artifactRefFromHit(app: string, hit: SearchHit): ArtifactRef {
  const openRef = hit.openRef;
  return {
    app,
    objectId: openRef?.objectId ?? hit.id,
    collection: openRef?.collection ?? null,
    projectId: openRef?.projectId ?? hit.projectId ?? null,
    kind: hit.kind,
    label: hit.title,
    ...(openRef?.action ? { action: openRef.action, params: openRef.params } : {}),
  };
}
