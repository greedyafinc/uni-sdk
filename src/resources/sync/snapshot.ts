// Snapshot codec. A snapshot is UTF-8 JSON encoded with `TextEncoder` (NOT node
// `Buffer`) so it stays in the browser-safe dependency graph. `decode` is total:
// any wrong version, a workspace-id mismatch, or a parse failure yields `null`
// (treated as "no snapshot"), so a corrupt blob can never throw out of the
// engine's `start()`.
import type { SyncRecord } from "./types";

/** Persisted snapshot envelope. `cursor` is the OPAQUE delta cursor to resume from. */
export interface SyncSnapshot {
  v: 1;
  workspaceId: string;
  cursor: string | null;
  savedAt: number;
  records: SyncRecord[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeSnapshot(
  workspaceId: string,
  cursor: string | null,
  records: SyncRecord[],
  savedAt: number,
): Uint8Array {
  const envelope: SyncSnapshot = { v: 1, workspaceId, cursor, savedAt, records };
  return encoder.encode(JSON.stringify(envelope));
}

/**
 * Decode a snapshot blob for `expectedWorkspaceId`. Returns `null` (ignore the
 * snapshot) when the bytes are corrupt, the version is not `1`, or the stored
 * `workspaceId` does not match — never throws.
 */
export function decodeSnapshot(
  bytes: Uint8Array,
  expectedWorkspaceId: string,
): SyncSnapshot | null {
  try {
    const parsed = JSON.parse(decoder.decode(bytes)) as Partial<SyncSnapshot>;
    if (!parsed || parsed.v !== 1) return null;
    if (parsed.workspaceId !== expectedWorkspaceId) return null;
    if (!Array.isArray(parsed.records)) return null;
    return {
      v: 1,
      workspaceId: parsed.workspaceId,
      cursor: parsed.cursor ?? null,
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      records: parsed.records,
    };
  } catch {
    return null;
  }
}
