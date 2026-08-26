import { describe, expect, test } from "bun:test";
import { UnifiedAI } from "../../src/core/client";
import { MemoryBackend } from "../../src/resources/storage";

interface Project extends Record<string, unknown> {
  id: string;
  name: string;
  updatedAt: number;
}

interface Artifact extends Record<string, unknown> {
  projectId: string;
  html: string;
  title: string;
}

function client(appId = "design-app") {
  return new UnifiedAI({ appId, storage: new MemoryBackend() });
}

describe("sdk.storage", () => {
  test("available() reflects a wired backend", () => {
    expect(client().storage.available()).toBe(true);
    // No injected backend + no token (not server-capable) → unavailable.
    expect(new UnifiedAI({}).storage.available()).toBe(false);
  });

  test("put/get round-trips a record", async () => {
    const db = client().storage.namespace();
    const projects = db.collection<Project>("projects", { key: "id", indexes: ["updatedAt"] });
    const ref = await projects.put({ id: "p1", name: "Coffee", updatedAt: 10 });
    expect(ref).toEqual({ id: "p1", version: 1, updatedAt: ref.updatedAt });
    expect(await projects.get("p1")).toEqual({ id: "p1", name: "Coffee", updatedAt: 10 });
    expect(await projects.get("missing")).toBeNull();
  });

  test("put replaces by key and bumps version", async () => {
    const projects = client()
      .storage.namespace()
      .collection<Project>("projects", { key: "id", indexes: ["updatedAt"] });
    const a = await projects.put({ id: "p1", name: "A", updatedAt: 1 });
    const b = await projects.put({ id: "p1", name: "B", updatedAt: 2 });
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    expect((await projects.get("p1"))?.name).toBe("B");
    expect(await projects.count()).toBe(1);
  });

  test("query filters, orders, and paginates; missing key throws", async () => {
    const projects = client()
      .storage.namespace()
      // Index both fields the test filters/orders on, so it exercises only
      // portable (indexed-field) query behavior.
      .collection<Project>("projects", { key: "id", indexes: ["updatedAt", "name"] });
    await projects.put({ id: "a", name: "A", updatedAt: 30 });
    await projects.put({ id: "b", name: "B", updatedAt: 10 });
    await projects.put({ id: "c", name: "C", updatedAt: 20 });

    const desc = await projects.query({ orderBy: "updatedAt", order: "desc" });
    expect(desc.map((p) => p.id)).toEqual(["a", "c", "b"]);

    const limited = await projects.query({ orderBy: "updatedAt", order: "asc", limit: 2 });
    expect(limited.map((p) => p.id)).toEqual(["b", "c"]);

    const filtered = await projects.query({ where: { name: "B" } });
    expect(filtered.map((p) => p.id)).toEqual(["b"]);

    await expect(
      projects.put({ name: "no key", updatedAt: 1 } as unknown as Project),
    ).rejects.toThrow(/missing required key/);
  });

  test("blob field is stored out-of-line: omitted from query, present in get", async () => {
    const artifacts = client()
      .storage.namespace()
      .collection<Artifact>("artifacts", { key: "projectId", blob: "html", versioned: true });
    await artifacts.put({ projectId: "p1", title: "Landing", html: "<h1>Hi</h1>" });

    const scanned = await artifacts.query();
    expect(scanned[0]?.title).toBe("Landing");
    expect(scanned[0]?.html).toBeUndefined(); // blob omitted from scans

    const full = await artifacts.get("p1");
    expect(full).toEqual({ projectId: "p1", title: "Landing", html: "<h1>Hi</h1>" });

    const bytes = await artifacts.blob("p1");
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe("<h1>Hi</h1>");
  });

  test("binary blob round-trips as bytes", async () => {
    interface Asset extends Record<string, unknown> {
      id: string;
      data: Uint8Array;
    }
    const assets = client()
      .storage.namespace()
      .collection<Asset>("assets", { key: "id", blob: "data" });
    const data = new Uint8Array([1, 2, 3, 250]);
    await assets.put({ id: "x", data });
    const got = await assets.get("x");
    expect(got?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(got?.data ?? [])).toEqual([1, 2, 3, 250]);
  });

  test("ArrayBuffer blob round-trips as an ArrayBuffer (not a Uint8Array view)", async () => {
    interface Buf extends Record<string, unknown> {
      id: string;
      data: ArrayBuffer;
    }
    const bufs = client().storage.namespace().collection<Buf>("bufs", { key: "id", blob: "data" });
    const data = new Uint8Array([9, 8, 7]).buffer;
    await bufs.put({ id: "x", data });
    const got = await bufs.get("x");
    expect(got?.data).toBeInstanceOf(ArrayBuffer);
    expect(got?.data).not.toBeInstanceOf(Uint8Array);
    expect(Array.from(new Uint8Array(got?.data ?? new ArrayBuffer(0)))).toEqual([9, 8, 7]);
  });

  test("filtering or ordering by the blob field throws invalid_input", async () => {
    interface Art extends Record<string, unknown> {
      id: string;
      html: string;
    }
    const arts = client().storage.namespace().collection<Art>("arts", { key: "id", blob: "html" });
    await arts.put({ id: "a", html: "<p>x</p>" });
    await expect(arts.query({ where: { html: "<p>x</p>" } })).rejects.toThrow(/blob field/);
    await expect(arts.query({ orderBy: "html" })).rejects.toThrow(/blob field/);
  });

  test("reverting a missing version throws not_found", async () => {
    const arts = client()
      .storage.namespace()
      .collection<Artifact>("artifacts", { key: "projectId", blob: "html", versioned: true });
    await arts.put({ projectId: "p1", title: "t", html: "<x/>" });
    await expect(arts.revert("p1", 99)).rejects.toThrow(/not found/);
  });

  test("versions, getVersion, and revert", async () => {
    const artifacts = client()
      .storage.namespace()
      .collection<Artifact>("artifacts", { key: "projectId", blob: "html", versioned: true });
    await artifacts.put({ projectId: "p1", title: "v1", html: "<p>1</p>" });
    await artifacts.put({ projectId: "p1", title: "v2", html: "<p>2</p>" });

    const versions = await artifacts.versions("p1");
    expect(versions.map((v) => v.version)).toEqual([2, 1]); // newest first

    const v1 = await artifacts.getVersion("p1", 1);
    expect(v1).toEqual({ projectId: "p1", title: "v1", html: "<p>1</p>" });

    const reverted = await artifacts.revert("p1", 1);
    expect(reverted.version).toBe(3); // revert writes a new head
    expect((await artifacts.get("p1"))?.html).toBe("<p>1</p>");
  });

  test("delete cascades blob + versions", async () => {
    const artifacts = client()
      .storage.namespace()
      .collection<Artifact>("artifacts", { key: "projectId", blob: "html", versioned: true });
    await artifacts.put({ projectId: "p1", title: "t", html: "<x/>" });
    expect(await artifacts.delete("p1")).toBe(true);
    expect(await artifacts.get("p1")).toBeNull();
    expect(await artifacts.blob("p1")).toBeNull();
    expect(await artifacts.versions("p1")).toEqual([]);
    expect(await artifacts.delete("p1")).toBe(false); // idempotent
  });

  test("namespaces isolate data; ungranted cross-app throws storage_not_granted", async () => {
    const sdk = client("app-a");
    const own = sdk.storage.namespace();
    expect(own.id).toBe("app-a");
    await own
      .collection<Project>("projects", { key: "id" })
      .put({ id: "p", name: "n", updatedAt: 1 });

    expect(() => sdk.storage.namespace("app-b")).toThrow(/no grant/);
    try {
      sdk.storage.namespace("app-b");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("storage_not_granted");
    }
  });

  test("unavailable backend throws on use", async () => {
    const projects = new UnifiedAI({}).storage
      .namespace()
      .collection<Project>("projects", { key: "id" });
    await expect(projects.get("p1")).rejects.toThrow(/no storage backend/);
  });
});
