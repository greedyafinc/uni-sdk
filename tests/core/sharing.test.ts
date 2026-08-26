import { describe, expect, test } from "bun:test";
import { UnifiedAI } from "../../src/core/client";
import {
  ForbiddenError,
  PlanRequiredError,
  UnifiedError,
  buildHttpError,
} from "../../src/core/errors";
import { storageTools, syncTools } from "../../src/resources/agent";
import { MemoryBackend } from "../../src/resources/storage";
import { PLAN_FREE_ID, isCloudPlan } from "../../src/resources/usage";
import { FakeSyncServer } from "../../src/testing";

interface Note extends Record<string, unknown> {
  id: string;
  title: string;
  body: string;
}

function pair(ownerApp = "notes", readerApp = "docs") {
  const backend = new MemoryBackend();
  const owner = new UnifiedAI({ appId: ownerApp, storage: backend });
  const reader = new UnifiedAI({ appId: readerApp, storage: backend });
  const agent = new UnifiedAI({ appId: "grok-bot", storage: backend, callerKind: "agent" });
  return { backend, owner, reader, agent };
}

describe("namespace sharing (storage)", () => {
  test("owner can grant another app read access to its namespace", async () => {
    const { owner, reader } = pair();
    const notes = owner.storage.namespace().collection<Note>("notes", { key: "id" });
    await notes.put({ id: "n1", title: "Hello", body: "world" });

    expect(() => reader.storage.namespace("notes")).toThrow(/no grant/);

    const grant = await owner.storage.grants.grant({
      grantee: { type: "app", appId: "docs" },
      mode: "read",
    });
    expect(grant.ns).toBe("notes");
    expect(grant.grantee).toEqual({ type: "app", appId: "docs" });
    expect(grant.mode).toBe("read");

    const listed = await owner.storage.grants.list();
    expect(listed.map((g) => g.id)).toEqual([grant.id]);

    const shared = reader.storage.namespace("notes");
    expect(shared.mode).toBe("read");
    expect(await shared.collection<Note>("notes", { key: "id" }).get("n1")).toEqual({
      id: "n1",
      title: "Hello",
      body: "world",
    });
    await expect(
      shared.collection<Note>("notes", { key: "id" }).put({ id: "n2", title: "x", body: "y" }),
    ).rejects.toThrow(/read-only/);
  });

  test("readwrite grant lets the consumer write when they request that mode", async () => {
    const { owner, reader } = pair();
    await owner.storage.grants.grant({
      grantee: { type: "app", appId: "docs" },
      mode: "readwrite",
    });
    const shared = reader.storage.namespace("notes", { mode: "readwrite" });
    await shared
      .collection<Note>("notes", { key: "id" })
      .put({ id: "n2", title: "from docs", body: "" });
    expect(
      await owner.storage.namespace().collection<Note>("notes", { key: "id" }).get("n2"),
    ).toMatchObject({ title: "from docs" });
  });

  test("agent grant lets callerKind:agent read; an app client still cannot", async () => {
    const { owner, reader, agent } = pair();
    await owner.storage
      .namespace()
      .collection<Note>("notes", { key: "id" })
      .put({ id: "n1", title: "secret", body: "" });
    await owner.storage.grants.grant({ grantee: { type: "agent" }, mode: "read" });

    expect(() => reader.storage.namespace("notes")).toThrow(/no grant/);
    const ns = agent.storage.namespace("notes");
    expect(await ns.collection<Note>("notes", { key: "id" }).get("n1")).toMatchObject({
      title: "secret",
    });
  });

  test("revoke removes access", async () => {
    const { owner, reader } = pair();
    const grant = await owner.storage.grants.grant({
      grantee: { type: "app", appId: "docs" },
    });
    expect(reader.storage.namespace("notes").id).toBe("notes");
    expect(await owner.storage.grants.revoke(grant.id)).toBe(true);
    expect(() => reader.storage.namespace("notes")).toThrow(/no grant/);
  });

  test("an app cannot grant someone else's namespace", async () => {
    const { reader } = pair();
    await expect(
      reader.storage.grants.grant({
        ns: "notes",
        grantee: { type: "app", appId: "docs" },
      }),
    ).rejects.toThrow(/owning app/);
  });

  test("storageTools read the bound namespace; write tools are opt-in", async () => {
    const { owner, agent } = pair();
    await owner.storage
      .namespace()
      .collection<Note>("notes", { key: "id" })
      .put({ id: "n1", title: "Hello", body: "world" });
    await owner.storage.grants.grant({ grantee: { type: "agent" }, mode: "read" });

    const readOnly = storageTools(agent.storage.namespace("notes"), {
      collections: ["notes"],
    });
    expect(readOnly.map((t) => t.definition.function.name)).toEqual([
      "storage_get",
      "storage_query",
    ]);
    const got = await readOnly[0]!.execute(
      { collection: "notes", id: "n1" },
      new AbortController().signal,
    );
    expect(got.isError).toBeUndefined();
    expect(JSON.parse(got.content)).toMatchObject({ title: "Hello" });

    const blocked = await readOnly[0]!.execute(
      { collection: "secrets", id: "n1" },
      new AbortController().signal,
    );
    expect(blocked.isError).toBe(true);

    await owner.storage.grants.grant({ grantee: { type: "agent" }, mode: "readwrite" });
    const writable = storageTools(agent.storage.namespace("notes", { mode: "readwrite" }), {
      collections: ["notes"],
      write: true,
    });
    expect(writable.map((t) => t.definition.function.name)).toContain("storage_put");
    const put = await writable
      .find((t) => t.definition.function.name === "storage_put")!
      .execute(
        { collection: "notes", record: { id: "n2", title: "from agent", body: "" } },
        new AbortController().signal,
      );
    expect(put.isError).toBeUndefined();
    expect(
      await owner.storage.namespace().collection<Note>("notes", { key: "id" }).get("n2"),
    ).toMatchObject({ title: "from agent" });
  });
});

describe("namespace sharing (sync)", () => {
  test("bootstrap omits ungranted namespaces; a grant reveals them", async () => {
    const server = new FakeSyncServer();
    server.seed("ws", [
      { ns: "planner", collection: "issues", id: "i1", metadata: { title: "Ship" } },
      { ns: "notes", collection: "notes", id: "n1", metadata: { title: "Private" } },
    ]);

    const owner = new UnifiedAI({
      apiUrl: server.baseUrl,
      token: "t",
      appId: "planner",
      fetch: server.fetch as unknown as typeof fetch,
    });
    const other = new UnifiedAI({
      apiUrl: server.baseUrl,
      token: "t",
      appId: "docs",
      fetch: server.fetch as unknown as typeof fetch,
    });

    const otherWs = other.sync.workspace("ws");
    await otherWs.start();
    await otherWs.sync();
    expect(otherWs.collection("planner", "issues").list()).toEqual([]);
    expect(otherWs.collection("notes", "notes").list()).toEqual([]);

    await owner.sync.grants.grant({
      grantee: { type: "app", appId: "docs" },
      mode: "read",
    });

    const other2 = new UnifiedAI({
      apiUrl: server.baseUrl,
      token: "t",
      appId: "docs",
      fetch: server.fetch as unknown as typeof fetch,
    });
    const ws2 = other2.sync.workspace("ws");
    await ws2.start();
    await ws2.sync();
    expect(
      ws2
        .collection("planner", "issues")
        .list()
        .map((r) => r.metadata.title),
    ).toEqual(["Ship"]);
    expect(ws2.collection("notes", "notes").list()).toEqual([]);
    await other2.sync.workspace("ws").stop();
    await otherWs.stop();
  });

  test("apply to an ungranted namespace returns sync_not_granted", async () => {
    const server = new FakeSyncServer();
    const sdk = new UnifiedAI({
      apiUrl: server.baseUrl,
      token: "t",
      appId: "docs",
      fetch: server.fetch as unknown as typeof fetch,
    });
    const ws = sdk.sync.workspace("ws");
    await ws.start();
    await expect(
      ws.apply([{ ns: "planner", collection: "issues", id: "i1", replace: { title: "x" } }]),
    ).rejects.toMatchObject({ code: "sync_not_granted" });
    await ws.stop();
  });

  test("agent grant + syncTools can list records", async () => {
    const server = new FakeSyncServer();
    server.seed("ws", [
      { ns: "planner", collection: "issues", id: "i1", metadata: { title: "Ship" } },
    ]);
    const owner = new UnifiedAI({
      apiUrl: server.baseUrl,
      token: "t",
      appId: "planner",
      fetch: server.fetch as unknown as typeof fetch,
    });
    await owner.sync.grants.grant({ grantee: { type: "agent" }, mode: "read" });

    const agent = new UnifiedAI({
      apiUrl: server.baseUrl,
      token: "t",
      appId: "grok-bot",
      callerKind: "agent",
      fetch: server.fetch as unknown as typeof fetch,
    });
    const ws = agent.sync.workspace("ws");
    await ws.start();
    await ws.sync();
    const tools = syncTools(ws, "planner", { collections: ["issues"] });
    const listed = tools
      .find((t) => t.definition.function.name === "sync_list")!
      .execute({ collection: "issues" }, new AbortController().signal);
    const result = listed instanceof Promise ? await listed : listed;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual([{ id: "i1", title: "Ship" }]);
    await ws.stop();
  });
});

describe("Pro cloud gate", () => {
  test("isCloudPlan: Free is id 0; any higher id is entitled", () => {
    expect(PLAN_FREE_ID).toBe(0);
    expect(isCloudPlan({ id: 0 })).toBe(false);
    expect(isCloudPlan({ id: 2 })).toBe(true);
  });

  test("403 plan_required maps to PlanRequiredError (upgrade-shaped, not ForbiddenError)", () => {
    const e = buildHttpError("msg", 403, {
      code: "plan_required",
      required_plan: "Pro",
      current_plan_id: 0,
      message: "Cloud sync and persistence require a Pro plan.",
    });
    expect(e).toBeInstanceOf(PlanRequiredError);
    expect(e).not.toBeInstanceOf(ForbiddenError);
    expect(e.code).toBe("plan_required");
    expect(e.status).toBe(403);
    const p = e as PlanRequiredError;
    expect(p.isPlanRequired).toBe(true);
    expect(p.requiredPlan).toBe("Pro");
    expect(p.currentPlanId).toBe(0);
  });

  test("403 storage_not_granted maps to ForbiddenError with that code", () => {
    const e = buildHttpError("msg", 403, {
      code: "storage_not_granted",
      message: 'no grant to access namespace "planner"',
    });
    expect(e).toBeInstanceOf(ForbiddenError);
    expect(e).not.toBeInstanceOf(PlanRequiredError);
    expect(e.code).toBe("storage_not_granted");
  });

  test("Free plan on FakeSyncServer refuses bootstrap/apply with PlanRequiredError", async () => {
    const server = new FakeSyncServer({ cloudPlanId: PLAN_FREE_ID });
    const sdk = new UnifiedAI({
      apiUrl: server.baseUrl,
      token: "t",
      appId: "planner",
      fetch: server.fetch as unknown as typeof fetch,
    });
    const ws = sdk.sync.workspace("ws");
    await ws.start();
    try {
      await ws.sync();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanRequiredError);
      expect((err as PlanRequiredError).requiredPlan).toBe("Pro");
      expect((err as PlanRequiredError).currentPlanId).toBe(0);
    }
    await expect(
      ws.apply([{ ns: "planner", collection: "issues", id: "i1", replace: { title: "x" } }]),
    ).rejects.toBeInstanceOf(PlanRequiredError);
    await ws.stop();
  });

  test("cloud storage put for a Free user throws PlanRequiredError", async () => {
    const fakeFetch = (async (_input: RequestInfo | URL) => {
      return new Response(
        JSON.stringify({
          code: "plan_required",
          required_plan: "Pro",
          current_plan_id: 0,
          message: "Cloud sync and persistence require a Pro plan.",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      appId: "planner",
      fetch: fakeFetch,
      retry: false,
    });
    await expect(
      sdk.storage.namespace().collection<Note>("notes", { key: "id" }).put({
        id: "n1",
        title: "x",
        body: "",
      }),
    ).rejects.toBeInstanceOf(PlanRequiredError);
  });

  test("cloud fs write for a Free user throws PlanRequiredError", async () => {
    const fakeFetch = (async () => {
      return new Response(
        JSON.stringify({
          code: "plan_required",
          required_plan: "Pro",
          current_plan_id: 0,
          message: "Cloud sync and persistence require a Pro plan.",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      appId: "planner",
      fetch: fakeFetch,
      retry: false,
    });
    await expect(sdk.fs.namespace().write("a.txt", "hi")).rejects.toBeInstanceOf(PlanRequiredError);
  });

  test("injected MemoryBackend keeps working for a Free user (no cloud path)", async () => {
    const sdk = new UnifiedAI({
      appId: "planner",
      storage: new MemoryBackend(),
      token: "t",
    });
    const notes = sdk.storage.namespace().collection<Note>("notes", { key: "id" });
    await notes.put({ id: "n1", title: "local", body: "" });
    expect(await notes.get("n1")).toMatchObject({ title: "local" });
  });

  test("listWorkspaces is not Pro-gated", async () => {
    const server = new FakeSyncServer({ cloudPlanId: PLAN_FREE_ID });
    server.registerWorkspace("ws", { name: "Personal", kind: "personal" });
    const sdk = new UnifiedAI({
      apiUrl: server.baseUrl,
      token: "t",
      fetch: server.fetch as unknown as typeof fetch,
    });
    const list = await sdk.sync.listWorkspaces();
    expect(list[0]?.id).toBe("ws");
  });
});

describe("sharing helpers", () => {
  test("ungranted local access throws UnifiedError storage_not_granted (not a 500)", () => {
    const { reader } = pair();
    try {
      reader.storage.namespace("notes");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnifiedError);
      expect((err as UnifiedError).code).toBe("storage_not_granted");
      expect((err as UnifiedError).status).toBeUndefined();
    }
  });
});
