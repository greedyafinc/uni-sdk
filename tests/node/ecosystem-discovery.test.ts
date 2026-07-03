import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverLocalEcosystem } from "../../src/node/_internal/ecosystem-discovery";

// Local-first discovery of the Ecosystem API loopback hosting (PROTOCOL.md "Local
// ecosystem hosting & discovery"). These pin the fall-through contract: a present +
// live hosting resolves to { baseUrl, token }; every failure mode (no file, bad file,
// dead port, wrong service, slow probe) resolves to null so the caller falls back to
// cloud — the discovery MUST NOT throw.

const realFetch = globalThis.fetch;
const dirs: string[] = [];

function discoveryFile(record: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "eco-"));
  dirs.push(dir);
  const path = join(dir, "ecosystem.json");
  writeFileSync(path, typeof record === "string" ? record : JSON.stringify(record));
  return path;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.UNIFIEDAI_ECOSYSTEM_URL;
  delete process.env.UNIFIEDAI_ECOSYSTEM_TOKEN;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("discoverLocalEcosystem — env handoff (bundled/class-3)", () => {
  test("env vars resolve directly, without a file or a probe", async () => {
    process.env.UNIFIEDAI_ECOSYSTEM_URL = "http://127.0.0.1:6001";
    process.env.UNIFIEDAI_ECOSYSTEM_TOKEN = "bundled-tok";
    let probed = false;
    globalThis.fetch = (async () => {
      probed = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    // No discovery file passed; env alone must resolve.
    expect(await discoverLocalEcosystem({ path: join(tmpdir(), "nope-eco.json") })).toEqual({
      baseUrl: "http://127.0.0.1:6001",
      token: "bundled-tok",
    });
    expect(probed).toBe(false);
  });

  test("only one env var set → falls through to the file path", async () => {
    process.env.UNIFIEDAI_ECOSYSTEM_URL = "http://127.0.0.1:6001";
    expect(await discoverLocalEcosystem({ path: join(tmpdir(), "nope-eco.json") })).toBeNull();
  });
});

describe("discoverLocalEcosystem — class-4 enroll upgrade", () => {
  test("an OAuth token upgrades the anonymous discovery token via /enroll", async () => {
    const path = discoveryFile({ url: "http://127.0.0.1:5555", token: "anon", pid: 1, started_at: 0 });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/health")) return new Response(JSON.stringify({ service: "ecosystem" }), { status: 200 });
      if (String(url).endsWith("/enroll")) {
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer my-oauth");
        return new Response(JSON.stringify({ token: "scoped-tok" }), { status: 200 });
      }
      return new Response("no", { status: 404 });
    }) as unknown as typeof fetch;
    expect(await discoverLocalEcosystem({ path, oauthToken: "my-oauth" })).toEqual({
      baseUrl: "http://127.0.0.1:5555",
      token: "scoped-tok",
    });
  });

  test("enroll failure (offline) falls back to the anonymous token", async () => {
    const path = discoveryFile({ url: "http://127.0.0.1:5555", token: "anon", pid: 1, started_at: 0 });
    globalThis.fetch = (async (url: string) =>
      String(url).endsWith("/health")
        ? new Response(JSON.stringify({ service: "ecosystem" }), { status: 200 })
        : new Response("nope", { status: 401 })) as unknown as typeof fetch;
    expect(await discoverLocalEcosystem({ path, oauthToken: "my-oauth" })).toEqual({
      baseUrl: "http://127.0.0.1:5555",
      token: "anon",
    });
  });
});

describe("discoverLocalEcosystem", () => {
  test("live hosting → { baseUrl, token }", async () => {
    const path = discoveryFile({ url: "http://127.0.0.1:5555", token: "tok", pid: 1, started_at: 0 });
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe("http://127.0.0.1:5555/health");
      return new Response(JSON.stringify({ ok: true, service: "ecosystem" }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await discoverLocalEcosystem({ path })).toEqual({ baseUrl: "http://127.0.0.1:5555", token: "tok" });
  });

  test("missing discovery file → null (no fetch)", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(await discoverLocalEcosystem({ path: join(tmpdir(), "does-not-exist-eco.json") })).toBeNull();
    expect(called).toBe(false);
  });

  test("malformed discovery file → null", async () => {
    const path = discoveryFile("not json{");
    expect(await discoverLocalEcosystem({ path })).toBeNull();
  });

  test("record missing url/token → null", async () => {
    const path = discoveryFile({ pid: 1, started_at: 0 });
    expect(await discoverLocalEcosystem({ path })).toBeNull();
  });

  test("dead port (probe throws) → null, never throws", async () => {
    const path = discoveryFile({ url: "http://127.0.0.1:1", token: "tok", pid: 1, started_at: 0 });
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await discoverLocalEcosystem({ path })).toBeNull();
  });

  test("wrong service identity → null (not our server)", async () => {
    const path = discoveryFile({ url: "http://127.0.0.1:5555", token: "tok", pid: 1, started_at: 0 });
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, service: "something-else" }), { status: 200 })) as unknown as typeof fetch;
    expect(await discoverLocalEcosystem({ path })).toBeNull();
  });

  test("non-200 health → null", async () => {
    const path = discoveryFile({ url: "http://127.0.0.1:5555", token: "tok", pid: 1, started_at: 0 });
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(await discoverLocalEcosystem({ path })).toBeNull();
  });
});
