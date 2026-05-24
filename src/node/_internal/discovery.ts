import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface DiscoveryRecord {
  readonly port: number;
  readonly pid: number;
  readonly started_at: number;
}

export interface DiscoveryReader {
  read(): Promise<DiscoveryRecord | null>;
}

export function defaultDiscoveryPath(): string {
  if (platform() === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "UnifiedAI", "desktop.json");
  }
  return join(homedir(), ".unifiedai", "desktop.json");
}

export function createDefaultDiscoveryReader(
  path: string = defaultDiscoveryPath(),
): DiscoveryReader {
  return {
    async read(): Promise<DiscoveryRecord | null> {
      try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw) as Partial<DiscoveryRecord>;
        if (
          typeof parsed.port !== "number" ||
          typeof parsed.pid !== "number" ||
          typeof parsed.started_at !== "number"
        ) {
          return null;
        }
        return parsed as DiscoveryRecord;
      } catch {
        return null;
      }
    },
  };
}
