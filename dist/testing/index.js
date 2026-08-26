// src/resources/_kv/keys.ts
function pkOf(ns, collection, id) {
  return JSON.stringify([ns, collection, id]);
}

// src/resources/sync/merge.ts
function mergePatch(base, patch) {
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === null)
      delete out[key];
    else
      out[key] = value;
  }
  return out;
}

// src/resources/sync/fake-server.ts
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
function errorResponse(status, code) {
  return jsonResponse(status, { code, message: code });
}
function encodeCursor(c) {
  return btoa(JSON.stringify(c));
}
function decodeCursor(raw) {
  try {
    const c = JSON.parse(atob(raw));
    if (typeof c.e !== "number" || typeof c.a !== "number")
      return null;
    return { e: c.e, a: c.a };
  } catch {
    return null;
  }
}

class FakeSyncServer {
  baseUrl;
  shared;
  workspaces = new Map;
  meta = new Map;
  failApply = false;
  offline = false;
  requestCount = 0;
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl ?? "https://fake-sync.test";
    this.shared = new Set(opts.sharedWorkspaces ?? []);
  }
  bumpEpoch(workspaceId) {
    this.ws(workspaceId).epoch += 1;
  }
  registerWorkspace(workspaceId, meta = {}) {
    this.ws(workspaceId);
    this.meta.set(workspaceId, {
      name: meta.name ?? workspaceId,
      kind: meta.kind ?? "team",
      role: meta.role ?? "owner"
    });
  }
  seed(workspaceId, records) {
    this.applyOps(workspaceId, records.map((r) => ({ ns: r.ns, collection: r.collection, id: r.id, replace: r.metadata })));
  }
  applyOps(workspaceId, ops) {
    const ws = this.ws(workspaceId);
    for (const op of ops)
      this.applyOne(ws, op);
  }
  remove(workspaceId, ns, collection, id) {
    this.applyOne(this.ws(workspaceId), { ns, collection, id, delete: true });
  }
  setApplyFailing(on) {
    this.failApply = on;
  }
  setOffline(on) {
    this.offline = on;
  }
  fetch = async (input, init) => {
    this.requestCount += 1;
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, this.baseUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const si = parts.indexOf("sync");
    if (si < 0)
      return errorResponse(404, "route_not_found");
    const method = (init?.method ?? "GET").toUpperCase();
    if (parts.length === si + 2 && parts[si + 1] === "workspaces" && method === "GET") {
      return this.listWorkspaces();
    }
    if (parts.length < si + 3)
      return errorResponse(404, "route_not_found");
    const workspaceId = decodeURIComponent(parts[si + 1] ?? "");
    const action = parts[si + 2];
    if (action === "bootstrap" && method === "GET")
      return this.bootstrap(workspaceId, url);
    if (action === "delta" && method === "GET")
      return this.delta(workspaceId, url);
    if (action === "apply" && method === "POST")
      return this.apply(workspaceId, init);
    return errorResponse(404, "route_not_found");
  };
  listWorkspaces() {
    const ids = new Set([...this.meta.keys(), ...this.workspaces.keys()]);
    const workspaces = [...ids].map((id) => {
      const m = this.meta.get(id);
      return { id, name: m?.name ?? id, kind: m?.kind ?? "personal", role: m?.role ?? "owner" };
    });
    return jsonResponse(200, { workspaces });
  }
  bootstrap(workspaceId, url) {
    if (this.offline)
      return errorResponse(503, "unavailable");
    const ws = this.ws(workspaceId);
    const limit = this.limit(url);
    const cursorRaw = url.searchParams.get("cursor");
    let after = 0;
    if (cursorRaw !== null) {
      const c = decodeCursor(cursorRaw);
      if (!c)
        return errorResponse(400, "invalid_cursor");
      if (c.e !== ws.epoch)
        return errorResponse(409, "cursor_epoch_mismatch");
      after = c.a;
    }
    const live = [...ws.records.values()].filter((r) => !r.deleted && r.syncId > after).sort((a, b) => a.syncId - b.syncId);
    const page = live.slice(0, limit);
    const complete = live.length <= limit;
    const lastInPage = page[page.length - 1];
    const newAfter = complete ? this.maxSyncId(ws) : lastInPage?.syncId ?? after;
    return jsonResponse(200, {
      records: page.map(toWire),
      cursor: encodeCursor({ e: ws.epoch, a: newAfter }),
      complete
    });
  }
  delta(workspaceId, url) {
    if (this.offline)
      return errorResponse(503, "unavailable");
    const ws = this.ws(workspaceId);
    const limit = this.limit(url);
    const cursorRaw = url.searchParams.get("cursor");
    let after = 0;
    if (cursorRaw !== null) {
      const c = decodeCursor(cursorRaw);
      if (!c)
        return errorResponse(400, "invalid_cursor");
      if (c.e !== ws.epoch)
        return errorResponse(409, "cursor_epoch_mismatch");
      after = c.a;
    }
    const changed = [...ws.records.values()].filter((r) => r.syncId > after).sort((a, b) => a.syncId - b.syncId);
    const page = changed.slice(0, limit);
    const hasMore = changed.length > limit;
    const lastInPage = page[page.length - 1];
    const newAfter = lastInPage?.syncId ?? after;
    return jsonResponse(200, {
      records: page.map((r) => r.deleted ? toTombstone(r) : toWire(r)),
      cursor: encodeCursor({ e: ws.epoch, a: newAfter }),
      hasMore
    });
  }
  apply(workspaceId, init) {
    if (this.failApply)
      return errorResponse(500, "internal");
    const ws = this.ws(workspaceId);
    let body;
    try {
      body = JSON.parse(String(init?.body ?? "{}"));
    } catch {
      return errorResponse(400, "bad_request");
    }
    const ops = body.ops;
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > 200) {
      return errorResponse(400, "bad_request");
    }
    const isShared = this.shared.has(workspaceId);
    const results = [];
    for (const op of ops) {
      if (isShared && (op.blob_hash !== undefined || op.bytes !== undefined)) {
        return errorResponse(400, "blobs_not_supported_in_shared_workspaces");
      }
      if (op.replace !== undefined && typeof op.replace !== "boolean") {
        return errorResponse(400, "invalid_op_replace_must_be_boolean");
      }
      const normalized = typeof op.replace === "boolean" ? op.replace ? { ...op, replace: op.patch ?? {}, patch: undefined } : { ...op, replace: undefined } : op;
      results.push(this.applyOne(ws, normalized));
    }
    return jsonResponse(200, { results });
  }
  applyOne(ws, op) {
    const ns = String(op.ns);
    const collection = String(op.collection);
    const id = String(op.id);
    const key = pkOf(ns, collection, id);
    const existing = ws.records.get(key);
    const now = Date.now();
    ws.seq += 1;
    const syncId = ws.seq;
    const version = (existing?.version ?? 0) + 1;
    let rec;
    if (op.delete === true) {
      rec = {
        ns,
        collection,
        id,
        metadata: {},
        version,
        deleted: true,
        syncId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        hasBlob: false
      };
    } else {
      let metadata;
      if (op.replace !== undefined)
        metadata = { ...op.replace };
      else if (op.patch !== undefined)
        metadata = mergePatch(existing?.metadata ?? {}, op.patch);
      else
        metadata = existing ? { ...existing.metadata } : {};
      const hasBlob = op.blob_hash !== undefined || op.bytes !== undefined ? true : existing?.hasBlob ?? false;
      const blobEncoding = op.blob_encoding ?? existing?.blobEncoding;
      rec = {
        ns,
        collection,
        id,
        metadata,
        version,
        deleted: false,
        syncId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        hasBlob,
        ...blobEncoding !== undefined ? { blobEncoding } : {}
      };
    }
    ws.records.set(key, rec);
    return { ns, collection, id, syncId, version };
  }
  ws(workspaceId) {
    let s = this.workspaces.get(workspaceId);
    if (!s) {
      s = { epoch: 1, seq: 0, records: new Map };
      this.workspaces.set(workspaceId, s);
    }
    return s;
  }
  limit(url) {
    const raw = Number(url.searchParams.get("limit"));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
  }
  maxSyncId(ws) {
    let max = 0;
    for (const r of ws.records.values())
      if (r.syncId > max)
        max = r.syncId;
    return max;
  }
}
function toWire(r) {
  return {
    ns: r.ns,
    collection: r.collection,
    id: r.id,
    metadata: r.metadata,
    version: r.version,
    deleted: r.deleted,
    syncId: r.syncId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    hasBlob: r.hasBlob,
    ...r.blobEncoding !== undefined ? { blobEncoding: r.blobEncoding } : {}
  };
}
function toTombstone(r) {
  return { ...toWire(r), deleted: true, metadata: {} };
}
export {
  FakeSyncServer
};

//# debugId=7F274472683F29B264756E2164756E21
//# sourceMappingURL=index.js.map
