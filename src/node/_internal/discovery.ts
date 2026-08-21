import { join } from "node:path";
import { defaultDiscoveryDir, readDiscoveryJson } from "./discovery-file";

export interface DiscoveryRecord {
  readonly port: number;
  readonly pid: number;
  readonly started_at: number;
}

export interface DiscoveryReader {
  read(): Promise<DiscoveryRecord | null>;
}

export function defaultDiscoveryPath(): string {
  return join(defaultDiscoveryDir(), "desktop.json");
}

export function createDefaultDiscoveryReader(
  path: string = defaultDiscoveryPath(),
): DiscoveryReader {
  return {
    read(): Promise<DiscoveryRecord | null> {
      return readDiscoveryJson<DiscoveryRecord>(path, (parsed) => {
        const p = parsed as Partial<DiscoveryRecord> | null;
        return (
          typeof p?.port === "number" &&
          typeof p?.pid === "number" &&
          typeof p?.started_at === "number"
        );
      });
    },
  };
}
