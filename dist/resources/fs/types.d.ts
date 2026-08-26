/** How a file's bytes are surfaced to the caller: utf8 text or raw binary. */
export type FsEncoding = "utf8" | "binary";
/** Read-only namespaces reject writes; read-write is the default for an app's own files. */
export type FsNamespaceMode = "read" | "readwrite";
/** A single entry returned by `list()`. Directories are implied by file paths. */
export interface FsEntry {
    /** Namespace-relative POSIX path, e.g. `"src/index.html"`. */
    path: string;
    /** Byte length of the file. */
    size: number;
    /** Last-modified epoch ms (best-effort; backends without mtime report `0`). */
    updatedAt: number;
}
/** Metadata for a single path, or `null` when it does not exist. */
export interface FsStat {
    path: string;
    size: number;
    updatedAt: number;
}
/** Options for `list()`. */
export interface FsListOptions {
    /** Restrict to entries under this namespace-relative directory prefix. */
    prefix?: string;
}
export interface FsNamespaceOptions {
    /** Access mode. Own-namespace defaults to `"readwrite"`; cross-app defaults to `"read"`. */
    mode?: FsNamespaceMode;
}
/**
 * A handle to one app's jailed file tree. All methods reject with a
 * `UnifiedError` (`fs_unavailable` when no backend is wired, `fs_read_only`
 * when writing through a read-only namespace, `invalid_path` when a path
 * escapes the jail, `not_found` / `edit_not_found` / `edit_not_unique` for the
 * obvious cases). Every path argument is normalized + jail-checked first.
 */
export interface FsNamespace {
    /** The resolved namespace id (the calling app's id, or a cross-app target). */
    readonly id: string;
    readonly mode: FsNamespaceMode;
    /** Read a file as UTF-8 text. Rejects with `not_found` if absent. */
    read(path: string): Promise<string>;
    /** Read a file's raw bytes. Rejects with `not_found` if absent. */
    readBytes(path: string): Promise<Uint8Array>;
    /** Create or overwrite a file (creating parent dirs as needed). */
    write(path: string, content: string | Uint8Array): Promise<void>;
    /**
     * Replace exactly one unique occurrence of `oldString` with `newString` in a
     * text file — the same contract as the agent loop's `edit_file` tool, so the
     * port maps 1:1. Rejects `edit_not_found` if absent, `edit_not_unique` if
     * `oldString` occurs more than once.
     */
    edit(path: string, oldString: string, newString: string): Promise<void>;
    /** List files, newest-first by path order is NOT guaranteed — sort if needed. */
    list(opts?: FsListOptions): Promise<FsEntry[]>;
    /** Whether a file exists at `path`. */
    exists(path: string): Promise<boolean>;
    /** Metadata for `path`, or `null` if absent. */
    stat(path: string): Promise<FsStat | null>;
    /** Delete a file. Returns `false` if it did not exist. */
    delete(path: string): Promise<boolean>;
}
/** A write request handed to the backend. Bytes only — encoding lives in the facade. */
export interface FsWriteReq {
    ns: string;
    path: string;
    bytes: Uint8Array;
}
/**
 * The file transport. The default is the server-backed Cloud backend; the
 * Tauri host injects a disk-backed one via `UnifiedAIOptions.fs`. Like `StorageBackend`,
 * it is untyped and trust-agnostic: in the host the calling app's identity
 * (`ns`) is re-derived and authorized at the IPC boundary, not taken on faith.
 *
 * Backends implement only primitive ops; `edit()` and utf8 encode/decode are
 * the facade's job (read-modify-write), so a new backend stays small.
 */
export interface FsBackend {
    /** Short identifier, e.g. `"cloud"` / `"tauri-fs"` — for diagnostics. */
    readonly name: string;
    /** Whether the backend can operate in the current runtime right now. */
    available(): boolean;
    /** Raw bytes of a file, or `null` when it does not exist. */
    read(ns: string, path: string): Promise<Uint8Array | null>;
    /** Create or overwrite, provisioning any parent directories. */
    write(req: FsWriteReq): Promise<void>;
    /** Files under `prefix` (or the whole namespace when omitted). */
    list(ns: string, prefix?: string): Promise<FsEntry[]>;
    /** Metadata for one path, or `null`. */
    stat(ns: string, path: string): Promise<FsStat | null>;
    /** Delete one file; `false` if it was absent. */
    delete(ns: string, path: string): Promise<boolean>;
}
//# sourceMappingURL=types.d.ts.map