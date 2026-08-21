import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

// Shared plumbing for the desktop-app discovery files (`desktop.json`,
// `ecosystem.json`). Node-only (node:fs) — never import from a browser bundle.

/** Platform config dir: `%APPDATA%\UnifiedAI` on Windows, `~/.unifiedai` elsewhere. */
export function defaultDiscoveryDir(): string {
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "UnifiedAI");
  }
  return join(homedir(), ".unifiedai");
}

/**
 * Read + parse + validate a discovery JSON file. Any failure — missing file,
 * unreadable, malformed JSON, failed validation — resolves to null; discovery
 * is always best-effort and the callers fall through to the next source.
 */
export async function readDiscoveryJson<T>(
  path: string,
  isValid: (parsed: unknown) => boolean,
): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}
