import type { SyncRecord } from "./types.js";
/** Persisted snapshot envelope. `cursor` is the OPAQUE delta cursor to resume from. */
export interface SyncSnapshot {
    v: 1;
    workspaceId: string;
    cursor: string | null;
    savedAt: number;
    records: SyncRecord[];
}
export declare function encodeSnapshot(workspaceId: string, cursor: string | null, records: SyncRecord[], savedAt: number): Uint8Array;
/**
 * Decode a snapshot blob for `expectedWorkspaceId`. Returns `null` (ignore the
 * snapshot) when the bytes are corrupt, the version is not `1`, or the stored
 * `workspaceId` does not match — never throws.
 */
export declare function decodeSnapshot(bytes: Uint8Array, expectedWorkspaceId: string): SyncSnapshot | null;
//# sourceMappingURL=snapshot.d.ts.map