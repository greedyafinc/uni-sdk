/**
 * Normalize a caller-supplied path to a safe namespace-relative POSIX path.
 * Throws `invalid_path` for absolute paths, empty paths, or any input that
 * traverses above the root. The returned value never starts with `/` or `.`
 * and never contains a `..` segment.
 */
export declare function normalizeRelPath(input: string): string;
/** Normalize a directory prefix for `list()` — like a path, but the root ("") is allowed. */
export declare function normalizePrefix(input: string | undefined): string;
/**
 * Normalize a namespace id to a single safe directory component, mirroring the
 * native backend's `sanitize_ns` so the SAME id resolves identically in both
 * runtimes. Empty maps to the shared "default" namespace; `.`/`..`/separators
 * and anything outside `[A-Za-z0-9._-]` are REJECTED (not lossily transformed,
 * which would let distinct ids collide into one tree); the result is lowercased
 * so case-variants can't alias on a case-insensitive filesystem.
 */
export declare function normalizeNs(input: string | undefined): string;
//# sourceMappingURL=path.d.ts.map