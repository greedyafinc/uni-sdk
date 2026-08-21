import { describe, expect, test } from "bun:test";
import { type FetchLike, type SearchBackend, webTools } from "../../src/index";
import { parseDdgHtml } from "../../src/resources/agent/_internal/ddg-search";
import { extractHtmlMeta } from "../../src/resources/agent/_internal/html-meta";
import { htmlToText } from "../../src/resources/agent/_internal/html-to-text";
import {
  assertSafeFetchUrl,
  isPrivateOrMetadataHost,
} from "../../src/resources/agent/_internal/ssrf";

describe("ssrf guards", () => {
  test("blocks loopback, RFC1918, link-local, metadata", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "10.0.0.1",
      "172.16.5.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.1.1",
      "0.0.0.0",
      "::1",
    ]) {
      expect(isPrivateOrMetadataHost(host)).toBe(true);
    }
  });

  test("allows public hosts", () => {
    expect(isPrivateOrMetadataHost("example.com")).toBe(false);
    expect(isPrivateOrMetadataHost("facebook.com")).toBe(false);
    expect(isPrivateOrMetadataHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrMetadataHost("1.1.1.1")).toBe(false);
  });

  test("assertSafeFetchUrl rejects non-http and private hosts", () => {
    expect(assertSafeFetchUrl("file:///etc/passwd").ok).toBe(false);
    expect(assertSafeFetchUrl("ftp://example.com/x").ok).toBe(false);
    expect(assertSafeFetchUrl("http://127.0.0.1/secret").ok).toBe(false);
    expect(assertSafeFetchUrl("https://169.254.169.254/latest").ok).toBe(false);
    const ok = assertSafeFetchUrl("https://example.com/page");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.url.hostname).toBe("example.com");
  });
});

describe("extractHtmlMeta", () => {
  test("prefers og:title and apple-touch-icon, resolves relative hrefs", () => {
    const html = `
      <html><head>
        <title>Fallback Title</title>
        <meta property="og:title" content="OG Title &amp; Co">
        <link rel="icon" href="/favicon.ico">
        <link rel="apple-touch-icon" href="/apple-touch-icon.png">
      </head><body></body></html>`;
    const meta = extractHtmlMeta(html, "https://news.example.com/story");
    expect(meta.title).toBe("OG Title & Co");
    expect(meta.icon).toBe("https://news.example.com/apple-touch-icon.png");
  });

  test("uses og:logo when no icon link is present", () => {
    const html = `<head><meta property="og:logo" content="https://cdn.example.com/logo.svg"></head>`;
    expect(extractHtmlMeta(html, "https://example.com/").icon).toBe(
      "https://cdn.example.com/logo.svg",
    );
  });
});

describe("htmlToText", () => {
  test("strips scripts/styles and collapses whitespace", () => {
    const html = `
      <html><head><style>.x{color:red}</style><script>alert(1)</script></head>
      <body><h1>Hello</h1><p>World &amp; friends</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Hello");
    expect(text).toContain("World & friends");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });

  test("truncates at maxChars", () => {
    const html = `<p>${"a".repeat(100)}</p>`;
    const text = htmlToText(html, 20);
    expect(text.length).toBeLessThan(100);
    expect(text).toContain("[truncated");
  });
});

describe("parseDdgHtml", () => {
  test("extracts title, url, snippet from DDG HTML", () => {
    const html = `
      <div class="result results_links">
        <a class="result__a" href="https://duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.com/a")}&rut=x">Example Title</a>
        <a class="result__snippet" href="#">A short snippet about example.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://other.example/b">Other</a>
        <div class="result__snippet">Second snippet</div>
      </div>`;
    const hits = parseDdgHtml(html, 5);
    expect(hits.length).toBe(2);
    expect(hits[0]?.title).toBe("Example Title");
    expect(hits[0]?.url).toBe("https://example.com/a");
    expect(hits[0]?.snippet).toContain("short snippet");
    expect(hits[1]?.url).toBe("https://other.example/b");
  });

  test("respects maxResults", () => {
    const html = Array.from(
      { length: 5 },
      (_, i) => `<a class="result__a" href="https://ex.com/${i}">T${i}</a>`,
    ).join("\n");
    expect(parseDdgHtml(html, 2)).toHaveLength(2);
  });
});

describe("webTools", () => {
  test("exposes web_search and web_fetch definitions", () => {
    const tools = webTools({
      search: {
        async search() {
          return [];
        },
      },
      fetch: (async () => new Response("")) as FetchLike,
    });
    const names = tools.map((t) => t.definition.function.name);
    expect(names).toEqual(["web_search", "web_fetch"]);
  });

  test("web_search formats hits from injected backend", async () => {
    const backend: SearchBackend = {
      async search(query) {
        expect(query).toBe("unified ai");
        return [
          { title: "UnifiedAI", url: "https://example.com/uai", snippet: "One API" },
          { title: "Docs", url: "https://example.com/docs", snippet: "" },
        ];
      },
    };
    const tools = webTools({ search: backend });
    const search = tools.find((t) => t.definition.function.name === "web_search");
    expect(search).toBeDefined();
    if (!search) throw new Error("missing tool");
    const sig = new AbortController().signal;
    const r = await search.execute({ query: "unified ai" }, sig);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("1. UnifiedAI");
    expect(r.content).toContain("https://example.com/uai");
    expect(r.content).toContain("One API");
    expect(r.content).toContain("2. Docs");
  });

  test("web_search rejects empty query", async () => {
    const tools = webTools({
      search: {
        async search() {
          return [];
        },
      },
    });
    const search = tools.find((t) => t.definition.function.name === "web_search");
    expect(search).toBeDefined();
    if (!search) throw new Error("missing tool");
    const r = await search.execute({ query: "  " }, new AbortController().signal);
    expect(r.isError).toBe(true);
  });

  test("web_fetch returns html-to-text for public URL", async () => {
    const fakeFetch: FetchLike = async (input) => {
      const url = String(input);
      expect(url).toBe("https://example.com/page");
      return new Response("<html><body><h1>Title</h1><p>Body text</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };
    const tools = webTools({ fetch: fakeFetch });
    const fetchTool = tools.find((t) => t.definition.function.name === "web_fetch");
    expect(fetchTool).toBeDefined();
    if (!fetchTool) throw new Error("missing tool");
    const r = await fetchTool.execute(
      { url: "https://example.com/page" },
      new AbortController().signal,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("URL: https://example.com/page");
    expect(r.content).toContain("Title");
    expect(r.content).toContain("Body text");
  });

  test("web_fetch includes Title and Icon from page metadata", async () => {
    const fakeFetch: FetchLike = async () =>
      new Response(
        `<html><head>
          <title>Example Domain</title>
          <link rel="apple-touch-icon" href="/apple-touch-icon.png">
        </head><body><p>Hello</p></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    const tools = webTools({ fetch: fakeFetch });
    const fetchTool = tools.find((t) => t.definition.function.name === "web_fetch");
    expect(fetchTool).toBeDefined();
    if (!fetchTool) throw new Error("missing tool");
    const r = await fetchTool.execute(
      { url: "https://example.com/page" },
      new AbortController().signal,
    );
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("Title: Example Domain");
    expect(r.content).toContain("Icon: https://example.com/apple-touch-icon.png");
    expect(r.content).toContain("Hello");
  });

  test("web_fetch blocks private hosts", async () => {
    let called = false;
    const tools = webTools({
      fetch: (async () => {
        called = true;
        return new Response("nope");
      }) as FetchLike,
    });
    const fetchTool = tools.find((t) => t.definition.function.name === "web_fetch");
    expect(fetchTool).toBeDefined();
    if (!fetchTool) throw new Error("missing tool");
    const r = await fetchTool.execute(
      { url: "http://192.168.0.1/admin" },
      new AbortController().signal,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Blocked host");
    expect(called).toBe(false);
  });

  test("web_fetch re-checks redirect target", async () => {
    const fakeFetch: FetchLike = async (input) => {
      const url = String(input);
      if (url === "https://example.com/go") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/secret" },
        });
      }
      return new Response("should not reach", { status: 200 });
    };
    const tools = webTools({ fetch: fakeFetch });
    const fetchTool = tools.find((t) => t.definition.function.name === "web_fetch");
    expect(fetchTool).toBeDefined();
    if (!fetchTool) throw new Error("missing tool");
    const r = await fetchTool.execute(
      { url: "https://example.com/go" },
      new AbortController().signal,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Blocked/);
  });

  test("web_search uses fake fetch against DDG HTML when no search backend", async () => {
    const ddgHtml = `
      <a class="result__a" href="https://example.com/r">Result One</a>
      <div class="result__snippet">Snippet one</div>`;
    const fakeFetch: FetchLike = async (input, init) => {
      expect(String(input)).toContain("duckduckgo.com");
      expect(init?.method).toBe("POST");
      return new Response(ddgHtml, { status: 200 });
    };
    const tools = webTools({ fetch: fakeFetch });
    const search = tools.find((t) => t.definition.function.name === "web_search");
    expect(search).toBeDefined();
    if (!search) throw new Error("missing tool");
    const r = await search.execute({ query: "test" }, new AbortController().signal);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("Result One");
    expect(r.content).toContain("https://example.com/r");
  });
});
