import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CassetteRequest {
  method: string;
  path: string;
  body: unknown;
}

export interface CassetteResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON-serializable body, or a raw string for SSE / non-JSON payloads. */
  body: unknown;
  /** Marks the body as a raw byte stream (SSE) that should be replayed verbatim. */
  stream?: boolean;
}

export interface CassetteInteraction {
  request: CassetteRequest;
  response: CassetteResponse;
}

export interface Cassette {
  interactions: CassetteInteraction[];
}

export const CASSETTE_ROOT = join(import.meta.dir, "..", "cassettes");

export function cassettePath(name: string): string {
  return join(CASSETTE_ROOT, `${name}.json`);
}

export function loadCassette(name: string): Cassette {
  const path = cassettePath(name);
  if (!existsSync(path)) {
    throw new Error(
      `Cassette not found: ${name}\nExpected file at ${path}\nRun with RECORD=true and a live unified-api to create it.`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as Cassette;
}

export function saveCassette(name: string, cassette: Cassette): void {
  const path = cassettePath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cassette, null, 2)}\n`);
}
