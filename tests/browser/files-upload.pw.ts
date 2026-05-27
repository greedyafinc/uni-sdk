// Real-browser test for sdk.files.upload. Loads the built browser bundle
// (`dist/index.browser.js`) into headless Chromium and exercises the upload
// surface against a Bun-hosted fake server. This catches engine-specific
// regressions that the Node/Bun unit tests would miss — most importantly:
//
//   - `atob` strictness with line-wrapped base64 (the SDK strips whitespace
//     before decode; this proves the strip actually fires in Chrome's atob).
//   - Browser `FormData` boundary handling (Chrome's fetch sets the
//     Content-Type with boundary differently than undici).
//   - `File` constructed from `Uint8Array` with non-default mime type.
//   - Empty `Blob.type` falling through to magic-byte sniffing.
//
// The bundle must be built first (`bun run build`); the test skips with a
// clear message otherwise.

import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// import.meta.dir is Bun-only; Playwright runs this spec under Node so use
// the portable fileURLToPath dance instead.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const BUNDLE_PATH = join(ROOT, "dist", "index.browser.js");

// Minimal 1×1 PNG (same bytes used by the Node unit tests).
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
  0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

interface ServerHandles {
  apiUrl: string;
  pageUrl: string;
  capturedBody: () => Buffer | null;
  stop: () => Promise<void>;
}

function listenOnEphemeralPort(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

function readBodyBytes(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function startHarness(): Promise<ServerHandles> {
  if (!existsSync(BUNDLE_PATH)) {
    throw new Error(
      `Browser bundle not found at ${BUNDLE_PATH}. Run \`bun run build:browser\` first.`,
    );
  }
  const bundle = readFileSync(BUNDLE_PATH, "utf8");

  // Fake upload endpoint. CORS-permissive so any origin can hit it from a
  // browser. Captures the most recent request body for assertions.
  let lastBody: Buffer | null = null;
  const corsHeaders: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
  const { server: apiServer, port: apiPort } = await listenOnEphemeralPort(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${apiPort}`);
    if (url.pathname === "/api/v1/images/uploads") {
      lastBody = await readBodyBytes(req);
      res.writeHead(200, { ...corsHeaders, "content-type": "application/json" });
      res.end(
        JSON.stringify({
          file_id: "file_browser_test",
          image_url: "https://x.example.com/y.png",
        }),
      );
      return;
    }
    res.writeHead(404, corsHeaders);
    res.end("not found");
  });

  // Static page server: serves the bundle + a tiny HTML harness that exposes
  // SDK upload helpers on `window` so Playwright can call them via evaluate.
  const { server: pageServer, port: pagePort } = await listenOnEphemeralPort((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${pagePort}`);
    if (url.pathname === "/bundle.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(bundle);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>SDK browser test</title></head>
  <body>
    <script type="module">
      import { UnifiedAI } from "/bundle.js";
      const API_URL = ${JSON.stringify(`http://127.0.0.1:${apiPort}`)};
      const sdk = new UnifiedAI({ apiUrl: API_URL, token: "browser-test" });
      window.__sdk = sdk;
      window.__uploadBytes = (bytes, opts) =>
        sdk.files.upload(new Uint8Array(bytes), opts);
      window.__uploadBlob = (bytes, type, name) => {
        const blob = type ? new Blob([new Uint8Array(bytes)], { type }) : new Blob([new Uint8Array(bytes)]);
        const source = name ? new File([blob], name, { type: type ?? "" }) : blob;
        return sdk.files.upload(source);
      };
      window.__uploadDataUrl = (b64, mime) =>
        sdk.files.upload(\`data:\${mime ?? "image/png"};base64,\${b64}\`);
      window.__ready = true;
    </script>
  </body>
</html>`;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  return {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    pageUrl: `http://127.0.0.1:${pagePort}/`,
    capturedBody: () => lastBody,
    stop: async () => {
      // Force-drop any keep-alive sockets Chromium left open. Without this,
      // server.close() waits for the socket-idle timeout (Node default 5s,
      // sometimes longer) and the test runner stalls until Playwright's
      // teardown timeout kicks in. closeAllConnections() is Node 18.2+.
      apiServer.closeAllConnections?.();
      pageServer.closeAllConnections?.();
      await new Promise<void>((r) => apiServer.close(() => r()));
      await new Promise<void>((r) => pageServer.close(() => r()));
    },
  };
}

test.describe("sdk.files.upload — real browser (Chromium)", () => {
  let h: ServerHandles;

  test.beforeAll(async () => {
    h = await startHarness();
  });
  test.afterAll(async () => {
    if (h) await h.stop();
  });

  test("uploads a Uint8Array with explicit contentType", async ({ page }) => {
    await page.goto(h.pageUrl);
    await page.waitForFunction(() => (window as Window & { __ready?: boolean }).__ready === true);

    const res = await page.evaluate(
      async ([bytes, opts]) => {
        const fn = (
          window as Window & { __uploadBytes?: (b: number[], o: unknown) => Promise<unknown> }
        ).__uploadBytes;
        return await fn?.(bytes as number[], opts);
      },
      [Array.from(PNG_1X1), { filename: "browser.png", contentType: "image/png" }] as const,
    );

    expect((res as { file_id: string }).file_id).toBe("file_browser_test");
    const body = h.capturedBody();
    expect(body).not.toBeNull();
    if (!body) throw new Error("expected captured body");
    expect(body.includes(Buffer.from(PNG_1X1))).toBe(true);
    const text = body.toString("binary");
    expect(text).toContain('name="file"');
    expect(text).toContain("browser.png");
    expect(text.toLowerCase()).toContain("content-type: image/png");
  });

  test("sniffs PNG magic bytes from a typed-less Blob (clipboard-style)", async ({ page }) => {
    await page.goto(h.pageUrl);
    await page.waitForFunction(() => (window as Window & { __ready?: boolean }).__ready === true);

    const res = await page.evaluate(
      async ([bytes]) => {
        const fn = (
          window as Window & {
            __uploadBlob?: (b: number[], t?: string, n?: string) => Promise<unknown>;
          }
        ).__uploadBlob;
        // No type, no name — exercises the empty-Blob.type sniff path.
        return await fn?.(bytes as number[]);
      },
      [Array.from(PNG_1X1)] as const,
    );

    expect((res as { file_id: string }).file_id).toBe("file_browser_test");
    const body = h.capturedBody();
    if (!body) throw new Error("expected captured body");
    const text = body.toString("binary");
    expect(text.toLowerCase()).toContain("content-type: image/png");
    expect(text).toContain('filename="upload.png"');
  });

  test("decodes a line-wrapped base64 data URL (Chrome atob whitespace path)", async ({ page }) => {
    await page.goto(h.pageUrl);
    await page.waitForFunction(() => (window as Window & { __ready?: boolean }).__ready === true);

    // Wrap base64 every 16 chars — Chrome's atob would throw on this without
    // the SDK's whitespace-stripping decoder. This is THE bug the unit test
    // can only cover by proxy (Bun's Buffer.from tolerates whitespace).
    const b64 = Buffer.from(PNG_1X1)
      .toString("base64")
      .replace(/(.{16})/g, "$1\n");

    const res = await page.evaluate(
      async ([wrapped]) => {
        const fn = (
          window as Window & { __uploadDataUrl?: (b: string, m?: string) => Promise<unknown> }
        ).__uploadDataUrl;
        return await fn?.(wrapped as string, "image/png");
      },
      [b64] as const,
    );

    expect((res as { file_id: string }).file_id).toBe("file_browser_test");
    const body = h.capturedBody();
    expect(body).not.toBeNull();
    expect(body?.includes(Buffer.from(PNG_1X1))).toBe(true);
  });

  test("preserves a File's .name as the multipart filename", async ({ page }) => {
    await page.goto(h.pageUrl);
    await page.waitForFunction(() => (window as Window & { __ready?: boolean }).__ready === true);

    await page.evaluate(
      async ([bytes, type, name]) => {
        const fn = (
          window as Window & {
            __uploadBlob?: (b: number[], t?: string, n?: string) => Promise<unknown>;
          }
        ).__uploadBlob;
        return await fn?.(bytes as number[], type as string, name as string);
      },
      [Array.from(PNG_1X1), "image/png", "user-picked.png"] as const,
    );

    const body = h.capturedBody();
    if (!body) throw new Error("expected captured body");
    const text = body.toString("binary");
    expect(text).toContain('filename="user-picked.png"');
    expect(text.toLowerCase()).toContain("content-type: image/png");
  });
});
