// Stand-in for the UnifiedApp desktop's local handoff server.
//
// Has its own session — once a user has "signed into UnifiedApp", that
// identity is persisted to .data/desktop/session.json and returned for any
// installed app that asks. Apps do not get to dictate who is signed in.
//
// Installed apps live in .data/desktop/installed.json. An app whose
// client_id is not in that list gets 404 — same shape as the real desktop.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ask } from "./lib-stdin";

const DESKTOP_DIR = join(import.meta.dir, ".data", "desktop");
const SESSION_FILE = join(DESKTOP_DIR, "session.json");
const INSTALLED_FILE = join(DESKTOP_DIR, "installed.json");

interface DesktopSession {
  readonly user_id: string;
  readonly signed_in_at: number;
}

function ensureDir(): void {
  if (!existsSync(DESKTOP_DIR)) mkdirSync(DESKTOP_DIR, { recursive: true });
}

function readSession(): DesktopSession | null {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8")) as DesktopSession;
  } catch {
    return null;
  }
}

function writeSession(s: DesktopSession): void {
  ensureDir();
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
}

function readInstalled(): string[] {
  if (!existsSync(INSTALLED_FILE)) return [];
  try {
    const v = JSON.parse(readFileSync(INSTALLED_FILE, "utf8")) as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function writeInstalled(ids: string[]): void {
  ensureDir();
  writeFileSync(INSTALLED_FILE, JSON.stringify(ids, null, 2));
}

export async function ensureDesktopSession(): Promise<DesktopSession> {
  const existing = readSession();
  if (existing) return existing;

  console.log("\nUnifiedApp · first launch");
  console.log("───────────────────────────");
  let username = "";
  while (!username) {
    username = (await ask("sign in — username: ")).trim();
    if (!username) console.log("(required)");
  }
  const session: DesktopSession = { user_id: username, signed_in_at: Date.now() };
  writeSession(session);
  console.log(`signed into UnifiedApp as "${session.user_id}"\n`);
  return session;
}

export function ensureAppInstalled(clientId: string): void {
  const installed = readInstalled();
  if (installed.includes(clientId)) return;
  installed.push(clientId);
  writeInstalled(installed);
}

export interface DesktopServer {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

export function startDesktopServer(opts: { quiet?: boolean } = {}): Promise<DesktopServer> {
  const log = opts.quiet ? () => {} : (m: string) => console.log(`[desktop] ${m}`);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/handoff" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json()) as { client_id?: string };
      const clientId = body.client_id ?? "";

      const installed = readInstalled();
      if (!installed.includes(clientId)) {
        log(`unknown app "${clientId}" → 404`);
        return new Response("unknown client", { status: 404 });
      }

      const session = readSession();
      if (!session) {
        log(`no desktop session → 401`);
        return new Response("not signed in", { status: 401 });
      }

      const access = `at_${randomBytes(16).toString("hex")}`;
      const refresh = `rt_${randomBytes(16).toString("hex")}`;
      log(`issued tokens for ${session.user_id}/${clientId}`);
      return Response.json({
        access_token: access,
        refresh_token: refresh,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user_id: session.user_id,
        client_id: clientId,
      });
    },
  });
  return Promise.resolve({
    port: server.port ?? 0,
    stop: async () => {
      await server.stop(true);
    },
  });
}

// Allow running this file directly to sign in / inspect state without
// launching an app: `bun run desktop-sim.ts [signin|signout|status]`.
if (import.meta.main) {
  const cmd = process.argv[2] ?? "status";
  if (cmd === "signin") {
    if (existsSync(SESSION_FILE)) {
      console.log("already signed in:", readSession());
      process.exit(0);
    }
    await ensureDesktopSession();
  } else if (cmd === "signout") {
    if (existsSync(SESSION_FILE)) {
      writeFileSync(SESSION_FILE, "");
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(SESSION_FILE);
      } catch {}
      console.log("signed out of UnifiedApp");
    } else {
      console.log("not signed in");
    }
  } else {
    const s = readSession();
    const installed = readInstalled();
    console.log("session:  ", s ?? "(none)");
    console.log("installed:", installed);
  }
}
