// demo-app — a tiny harness for exercising @unifiedai/sdk.
//
// Authenticates via the SDK, serves a small UI over Bun.serve, and opens it
// in the browser. UI talks back to local JSON routes that drive the SDK.

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { UnifiedError } from "../../src/index";
import { listModels, me, signOut, testRefresh } from "./routes";
import { sdk } from "./sdk";

function openInBrowser(url: string): void {
  const p = platform();
  const cmd = p === "darwin" ? "open" : p === "win32" ? "cmd" : "xdg-open";
  const args = p === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

try {
  await sdk.bootstrap();
} catch (e) {
  const msg = e instanceof UnifiedError ? `${e.code} — ${e.message}` : (e as Error).message;
  console.error(`sign-in failed: ${msg}`);
  process.exit(1);
}

const identity = sdk.identity();
console.log(`signed in as ${identity.user_id}`);

const PUBLIC_DIR = new URL("./public/", import.meta.url);

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = Bun.file(new URL(rel, PUBLIC_DIR));
  if (!(await file.exists())) return new Response("not found", { status: 404 });
  return new Response(file);
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/me") return me(identity);
    if (req.method === "POST" && url.pathname === "/list-models") return listModels();
    if (req.method === "POST" && url.pathname === "/test-refresh") return testRefresh();
    if (req.method === "POST" && url.pathname === "/signout") return signOut(identity);

    if (req.method === "GET") return serveStatic(url.pathname);
    return new Response("not found", { status: 404 });
  },
});

const appUrl = `http://127.0.0.1:${server.port}/`;
console.log(`opening ${appUrl}`);
openInBrowser(appUrl);
