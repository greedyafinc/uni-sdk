import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// Local-first discovery of the LOCAL Ecosystem API hosting, per PROTOCOL.md
// "Local ecosystem hosting & discovery". Mirrors discovery.ts (the auth handoff
// discovery), but resolves the ecosystem loopback base URL + per-launch token and
// verifies liveness with a fail-fast /health probe. When the running desktop app is
// present, an SDK prefers this hosting (offline-capable, the only home of non-synced
// data); when absent or stale, it returns null and the caller falls back to the cloud
// hosting (UNIFIEDAI_API_URL). Node-only (node:fs) — never import from a browser bundle.

export interface EcosystemDiscoveryRecord {
  readonly url: string;
  readonly token: string;
  readonly pid: number;
  readonly started_at: number;
}

/** The resolved local hosting: base URL + the bearer token to authenticate with. */
export interface LocalEcosystem {
  readonly baseUrl: string;
  readonly token: string;
}

export function defaultEcosystemDiscoveryPath(): string {
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "UnifiedAI", "ecosystem.json");
  }
  return join(homedir(), ".unifiedai", "ecosystem.json");
}

async function readRecord(path: string): Promise<EcosystemDiscoveryRecord | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<EcosystemDiscoveryRecord>;
    if (typeof parsed.url !== "string" || typeof parsed.token !== "string") return null;
    return parsed as EcosystemDiscoveryRecord;
  } catch {
    return null;
  }
}

export interface DiscoverOptions {
  /** Override the discovery-file path (tests). */
  readonly path?: string;
  /** Fail-fast probe deadline; PROTOCOL suggests ~500 ms. */
  readonly timeoutMs?: number;
  /** A standalone (class-4) app's OAuth access token. When set, the anonymous discovery
   *  token is upgraded to a scoped one via POST /enroll (offline → stays anonymous). */
  readonly oauthToken?: string;
}

/** Exchange an OAuth token for a scoped class-4 local token via /enroll; null on failure. */
async function enrollLocal(
  baseUrl: string,
  oauthToken: string,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/enroll`, {
      method: "POST",
      headers: { authorization: `Bearer ${oauthToken}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return typeof body.token === "string" ? body.token : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the local Ecosystem API hosting, or null to fall back to cloud. Resolution
 * order (docs/ecosystem-local-tokens.md §8):
 *   1. **Env handoff** — `UNIFIEDAI_ECOSYSTEM_URL` + `UNIFIEDAI_ECOSYSTEM_TOKEN`. A
 *      BUNDLED app (class 3) receives a pre-scoped token from the shell at launch this
 *      way; trusted without a probe (the shell set it for this exact child process).
 *   2. **Discovery file** — read `~/.unifiedai/ecosystem.json` + probe `GET <url>/health`.
 *      The file's token is the powerless anonymous identity; a standalone app (class 4)
 *      enrolls for real scopes (§9), which is a later addition.
 * A stale file (dead port) resolves to null because the probe fails — never throws.
 */
export async function discoverLocalEcosystem(
  opts: DiscoverOptions = {},
): Promise<LocalEcosystem | null> {
  // 1. Env handoff (bundled apps) — the shell injected these for this child.
  const envUrl = process.env.UNIFIEDAI_ECOSYSTEM_URL;
  const envToken = process.env.UNIFIEDAI_ECOSYSTEM_TOKEN;
  if (envUrl && envToken) {
    return { baseUrl: envUrl, token: envToken };
  }

  // 2. Discovery file + liveness probe.
  const record = await readRecord(opts.path ?? defaultEcosystemDiscoveryPath());
  if (!record) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 500);
  try {
    const res = await fetch(`${record.url}/health`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { service?: string };
    if (body?.service !== "ecosystem") return null;
    // Class-4: upgrade the powerless anonymous discovery token to a scoped one.
    if (opts.oauthToken) {
      const scoped = await enrollLocal(record.url, opts.oauthToken, opts.timeoutMs ?? 500);
      if (scoped) return { baseUrl: record.url, token: scoped };
    }
    return { baseUrl: record.url, token: record.token };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
