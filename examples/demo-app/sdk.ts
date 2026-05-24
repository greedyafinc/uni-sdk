// SDK singleton + intercepting fetch.
//
// The intercepting fetch lets the "Test refresh" button deterministically
// force a 401 on a synthetic /__demo/ping endpoint so we can exercise the
// SDK's transparent-refresh path. All other traffic passes through to
// unified-api unchanged.

// Imports the node-capable UnifiedAI subclass — this demo runs the full
// OAuth/keychain/handoff flow against unified-api locally.
import { UnifiedAI } from "../../src/node/index";
import { APP_ID } from "./constants";

const API_BASE = process.env.UNIFIEDAI_API_BASE ?? "http://localhost:3141";

const realFetch = globalThis.fetch.bind(globalThis);

export const refreshTest = {
  forceNext401: false,
  lastBearer: "",
};

const interceptingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input as Request).url;
  if (url.includes("/__demo/ping")) {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    refreshTest.lastBearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (refreshTest.forceNext401) {
      refreshTest.forceNext401 = false;
      return new Response("unauthorized", { status: 401 });
    }
    return Response.json({ ok: true });
  }
  return realFetch(input, init);
};

export const sdk = new UnifiedAI({
  appId: APP_ID,
  apiUrl: API_BASE,
  fetch: interceptingFetch,
});
