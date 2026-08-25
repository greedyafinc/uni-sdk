import { describe, expect, test } from "bun:test";
import {
  OPEN_ARTIFACT_ACTION,
  OPEN_ARTIFACT_SPEC,
  type ProjectLink,
  type SearchHit,
  artifactRefFromHit,
  artifactRefFromLink,
  isResolvableArtifactRef,
  toOpenArtifactParams,
} from "../../src/index";

// The cross-app OPEN contract. These adapters are what let a stored ProjectLink
// (written by a different app, before the target app had actions) and a live
// search hit reach the SAME shell code path.

function link(over: Partial<ProjectLink> = {}): ProjectLink {
  return {
    id: "lnk_1",
    projectId: "prj_1",
    targetApp: "design",
    targetAppId: null,
    targetKind: "object",
    collection: "designs",
    objectId: "dsg_1",
    path: null,
    fragment: {},
    artifactType: "design",
    label: "Landing page",
    role: "member",
    addedByApp: "planner",
    hasSnapshot: false,
    snapshotPreview: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe("OPEN_ARTIFACT_SPEC", () => {
  // `mutates` is fail-closed everywhere in the ecosystem: an action that merely
  // OMITS the flag is treated as a write and refused on read-only paths, with no
  // error and no failing test. Pinning it here is what makes that visible.
  test("declares mutates: false explicitly", () => {
    expect(OPEN_ARTIFACT_SPEC.mutates).toBe(false);
    expect(OPEN_ARTIFACT_SPEC.tier).toBe("safe");
  });

  test("stays off the model-facing MCP surface", () => {
    // Apps keep their own richly-described open actions for the agent; this one
    // is shell plumbing and would only add a confusable duplicate.
    expect(OPEN_ARTIFACT_SPEC.exposeToMcp).toBe(false);
  });

  test("id matches the exported action constant", () => {
    expect(OPEN_ARTIFACT_SPEC.id).toBe(OPEN_ARTIFACT_ACTION);
  });

  test("params reject unknown keys so apps cannot quietly extend the shape", () => {
    expect(OPEN_ARTIFACT_SPEC.params.additionalProperties).toBe(false);
  });
});

describe("artifactRefFromLink", () => {
  test("maps a whole-object link", () => {
    const ref = artifactRefFromLink(link());
    expect(ref).toEqual({
      app: "design",
      objectId: "dsg_1",
      path: null,
      collection: "designs",
      projectId: "prj_1",
      kind: "design",
      label: "Landing page",
    });
  });

  test("carries a portion locator through", () => {
    const ref = artifactRefFromLink(link({ fragment: { componentId: "c_9" } }));
    expect(ref.fragment).toEqual({ componentId: "c_9" });
  });

  test("an empty fragment is dropped rather than sent as {}", () => {
    // `{}` and absent mean the same thing (whole artifact); sending the empty
    // object makes handlers write `if (params.fragment)` branches that lie.
    expect(toOpenArtifactParams(artifactRefFromLink(link()))).not.toHaveProperty("fragment");
  });

  test("file-backed links resolve by path", () => {
    const ref = artifactRefFromLink(
      link({ targetKind: "file", objectId: null, path: "notes/q3.md", collection: null }),
    );
    expect(ref.objectId).toBeNull();
    expect(ref.path).toBe("notes/q3.md");
    expect(isResolvableArtifactRef(ref)).toBe(true);
  });

  test("a link with neither id nor path is not resolvable", () => {
    const ref = artifactRefFromLink(link({ objectId: null, path: null }));
    expect(isResolvableArtifactRef(ref)).toBe(false);
  });
});

describe("artifactRefFromHit", () => {
  function hit(over: Partial<SearchHit> = {}): SearchHit {
    return { id: "n_1", kind: "note", title: "Q3 Budget", score: 1, ...over };
  }

  test("falls back to the hit id when no openRef is present", () => {
    const ref = artifactRefFromHit("notes", hit());
    expect(ref.app).toBe("notes");
    expect(ref.objectId).toBe("n_1");
    expect(ref.kind).toBe("note");
    expect(ref.action).toBeUndefined();
  });

  test("prefers openRef.objectId over the hit id", () => {
    const ref = artifactRefFromHit("sheets", hit({ openRef: { objectId: "sh_7" } }));
    expect(ref.objectId).toBe("sh_7");
  });

  test("promotes a per-hit action to the override", () => {
    const ref = artifactRefFromHit(
      "sheets",
      hit({ openRef: { objectId: "sh_7", action: "openSheet", params: { range: "B2:D9" } } }),
    );
    expect(ref.action).toBe("openSheet");
    expect(ref.params).toEqual({ range: "B2:D9" });
  });

  test("carries the hit's project when openRef omits one", () => {
    const ref = artifactRefFromHit("docs", hit({ projectId: "prj_3" }));
    expect(ref.projectId).toBe("prj_3");
  });
});

describe("toOpenArtifactParams", () => {
  test("drops routing-only fields the handler must not see", () => {
    const params = toOpenArtifactParams({
      app: "planner",
      objectId: "iss_1",
      kind: "issue",
      projectId: "prj_1",
      label: "Ship it",
      action: "openItem",
      params: { kind: "issue", id: "iss_1" },
    });
    // app/projectId/label/action are the SHELL's business — an app receiving
    // them would start routing on data it does not own.
    expect(params).toEqual({ objectId: "iss_1", kind: "issue" });
  });
});
