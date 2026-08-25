// The host-action envelope (src/app/actions/index.ts): message-builder
// formats, the openArtifact param normalization, and safeRegisterActions'
// swallow-on-throw contract.
import { describe, expect, it } from "bun:test";

import {
  type OpenArtifactRef,
  makeOpenArtifactAdapter,
  notFound,
  requiredParam,
  safeRegisterActions,
  storageUnavailable,
} from "../../src/app/actions/index";

describe("error message builders", () => {
  it("requiredParam without a hint ends in a period", () => {
    expect(requiredParam("title")).toBe("title is required.");
  });

  it("requiredParam appends the hint after an em dash", () => {
    expect(requiredParam("name", "it becomes the new note's title.")).toBe(
      "name is required — it becomes the new note's title.",
    );
  });

  it("notFound without a hint is a single sentence", () => {
    expect(notFound("Document", "abc123")).toBe("Document not found: abc123.");
  });

  it("notFound appends the app's id-source hint as its own sentence", () => {
    expect(notFound("Sheet", "s1", "Use sheets__listSheets to see available sheets.")).toBe(
      "Sheet not found: s1. Use sheets__listSheets to see available sheets.",
    );
  });

  it("storageUnavailable names the app and the caller-facing verb phrase", () => {
    expect(storageUnavailable("Docs", "cannot open the document")).toBe(
      "Docs storage is unavailable — cannot open the document.",
    );
  });
});

describe("makeOpenArtifactAdapter", () => {
  const capture = () => {
    const seen: OpenArtifactRef[] = [];
    const adapter = makeOpenArtifactAdapter((ref) => {
      seen.push(ref);
      return ref.objectId;
    });
    return { seen, adapter };
  };

  it("passes all four fields through when well-formed", async () => {
    const { seen, adapter } = capture();
    await adapter({ objectId: "d1", fragment: { tab: 2 }, kind: "doc", collection: "docs" });
    expect(seen[0]).toEqual({
      objectId: "d1",
      fragment: { tab: 2 },
      kind: "doc",
      collection: "docs",
    });
  });

  it("normalizes a missing objectId to the empty string", async () => {
    const { seen, adapter } = capture();
    await adapter({});
    expect(seen[0]).toEqual({ objectId: "" });
  });

  it("tolerates undefined/null params entirely", async () => {
    const { seen, adapter } = capture();
    await adapter(undefined);
    await adapter(null);
    expect(seen).toEqual([{ objectId: "" }, { objectId: "" }]);
  });

  it("drops non-string kind/collection and non-string objectId", async () => {
    const { seen, adapter } = capture();
    await adapter({ objectId: 42, kind: 7, collection: {} });
    expect(seen[0]).toEqual({ objectId: "" });
  });

  it("omits fragment only when undefined — null and falsy values still travel", async () => {
    const { seen, adapter } = capture();
    await adapter({ objectId: "x", fragment: null });
    expect(seen[0]).toEqual({ objectId: "x", fragment: null });
    expect("fragment" in (seen[0] as object)).toBe(true);
  });

  it("returns the open action's result", async () => {
    const adapter = makeOpenArtifactAdapter((ref) => `opened:${ref.objectId}`);
    expect(await adapter({ objectId: "z" })).toBe("opened:z");
  });
});

describe("safeRegisterActions", () => {
  it("runs the thunk when registration succeeds", () => {
    let ran = false;
    safeRegisterActions("docs", () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("swallows a throwing thunk and warns instead of crashing module load", () => {
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      expect(() =>
        safeRegisterActions("docs", () => {
          throw new Error("no host");
        }),
      ).not.toThrow();
    } finally {
      console.warn = original;
    }
    expect(warnings.length).toBe(1);
    expect(String(warnings[0]?.[0])).toContain("[docs] registerActions failed");
  });
});
