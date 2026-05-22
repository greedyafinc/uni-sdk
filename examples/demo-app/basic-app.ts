// demo-app — a tiny marketplace app built on @unifiedai/sdk.
//
// Authenticates via the SDK, then opens a small web UI showing the signed-in
// user and a sign-out button.

import { spawn } from "node:child_process";
import { platform } from "node:os";
import { UnifiedAI, UnifiedError } from "../../src/index";
import { APP_ID } from "./constants";

function openInBrowser(url: string): void {
  const p = platform();
  const cmd = p === "darwin" ? "open" : p === "win32" ? "cmd" : "xdg-open";
  const args = p === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

const sdk = new UnifiedAI({ appId: APP_ID });

try {
  await sdk.bootstrap();
} catch (e) {
  const msg = e instanceof UnifiedError ? `${e.code} — ${e.message}` : (e as Error).message;
  console.error(`sign-in failed: ${msg}`);
  process.exit(1);
}

const identity = sdk.identity();
console.log(`signed in as ${identity.user_id}`);

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>demo-app</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: linear-gradient(135deg, #fef9e7, #fef3c7);
      color: #1f2937;
    }
    @media (prefers-color-scheme: dark) {
      body { background: linear-gradient(135deg, #0f172a, #1e293b); color: #e2e8f0; }
      .card { background: #1e293b; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
    }
    .card {
      max-width: 420px;
      width: calc(100% - 32px);
      padding: 32px;
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,.08);
      text-align: center;
    }
    .brand { font-size: 14px; letter-spacing: .12em; text-transform: uppercase; opacity: .6; }
    .title { font-size: 28px; font-weight: 600; margin: 8px 0 24px; }
    .avatar {
      width: 72px; height: 72px; margin: 0 auto 16px;
      border-radius: 50%;
      background: linear-gradient(135deg, #f59e0b, #ef4444);
      color: white; font-size: 28px; font-weight: 600;
      display: grid; place-items: center;
    }
    .user-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; opacity: .7; word-break: break-all; }
    .meta { font-size: 13px; opacity: .6; margin-top: 4px; }
    button {
      margin-top: 24px;
      padding: 10px 20px;
      font: inherit; font-weight: 500;
      border: 1px solid currentColor;
      border-radius: 8px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      transition: background .15s;
    }
    button:hover { background: rgba(127,127,127,.1); }
    button:disabled { opacity: .4; cursor: wait; }
    .farewell { display: none; }
    .farewell.show { display: block; }
    .signed-in.hide { display: none; }
  </style>
</head>
<body>
  <main class="card">
    <div class="signed-in">
      <div class="brand">demo-app</div>
      <h1 class="title">Signed in</h1>
      <div class="avatar">${escapeHtml(initial(identity.user_id))}</div>
      <div class="user-id">${escapeHtml(identity.user_id)}</div>
      <div class="meta">client: ${escapeHtml(identity.client_id)}</div>
      <button id="signout">Sign out</button>
    </div>
    <div class="farewell">
      <div class="brand">demo-app</div>
      <h1 class="title">Signed out</h1>
      <p>You can close this tab.</p>
    </div>
  </main>
  <script>
    document.getElementById("signout").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        await fetch("/signout", { method: "POST" });
      } catch {}
      document.querySelector(".signed-in").classList.add("hide");
      document.querySelector(".farewell").classList.add("show");
    });
  </script>
</body>
</html>`;

function initial(s: string): string {
  return (s.trim()[0] ?? "?").toUpperCase();
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const url = new URL(req.url);

    if (url.pathname === "/signout" && req.method === "POST") {
      try {
        await sdk.signOut();
      } catch (e) {
        console.error("sign-out failed:", e);
      }
      console.log(`signed out ${identity.user_id}`);
      setTimeout(() => process.exit(0), 250);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/") {
      return new Response(page, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

const appUrl = `http://127.0.0.1:${server.port}/`;
console.log(`opening ${appUrl}`);
openInBrowser(appUrl);
