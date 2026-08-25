// The text chores (src/app/text/index.ts): the 5-entity escape, word-boundary
// truncation with its minKeepRatio fallback, and the preview clamp.
import { describe, expect, it } from "bun:test";

import {
  PREVIEW_MAX,
  SEARCH_TEXT_MAX,
  clampWithEllipsis,
  escapeHtml,
  truncateOnWord,
} from "../../src/app/text/index";

describe("escapeHtml", () => {
  it("escapes all five entities", () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
    );
  });

  it("replaces & first so entities are not double-escaped", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("passes plain text through unchanged", () => {
    expect(escapeHtml("plain text")).toBe("plain text");
  });
});

describe("truncateOnWord", () => {
  it("returns short input untouched", () => {
    expect(truncateOnWord("short", 10)).toBe("short");
  });

  it("cuts at the last word boundary inside the cap", () => {
    expect(truncateOnWord("alpha beta gamma", 12)).toBe("alpha beta");
  });

  it("hard-cuts a single oversized token at exactly max", () => {
    expect(truncateOnWord("a".repeat(50), 10)).toBe("a".repeat(10));
  });

  it("never ends in whitespace", () => {
    const out = truncateOnWord("word  another word tail", 14);
    expect(out).toBe(out.trimEnd());
    expect(out.length).toBeLessThanOrEqual(14);
  });

  it("minKeepRatio rejects a too-early break in favor of the hard cut", () => {
    // Space at index 1; with a 0.6 floor on max=20 the break must land >= 12.
    const text = `a ${"b".repeat(40)}`;
    expect(truncateOnWord(text, 20, 0.6)).toBe(text.slice(0, 20).trimEnd());
  });

  it("minKeepRatio accepts a break at or past the floor", () => {
    const text = `${"a".repeat(15)} ${"b".repeat(40)}`;
    expect(truncateOnWord(text, 20, 0.6)).toBe("a".repeat(15));
  });
});

describe("clampWithEllipsis", () => {
  it("returns short input untouched, with no ellipsis", () => {
    expect(clampWithEllipsis("short", 10)).toBe("short");
  });

  it("clamps to max INCLUDING the ellipsis, on a character boundary", () => {
    const out = clampWithEllipsis("abcdefghij", 8);
    expect(out).toBe("abcdefg…");
    expect(out.length).toBe(8);
  });

  it("trims trailing whitespace before appending the ellipsis", () => {
    expect(clampWithEllipsis("abc    defghi", 8)).toBe("abc…");
  });
});

describe("shared bounds", () => {
  it("keeps the documented values", () => {
    expect(PREVIEW_MAX).toBe(160);
    expect(SEARCH_TEXT_MAX).toBe(1200);
  });
});
