/**
 * Bytes-only magic sniffer (images, PDF, audio, video). Used directly by
 * `files.create`, and as the final stage of {@link detectMime}. Deliberately
 * ignores filenames — callers that want extension hints use `detectMime`.
 */
export declare function sniffMime(bytes: Uint8Array): string | null;
/**
 * Full detector: Blob `type` → filename extension → magic bytes
 * ({@link sniffMime}).
 */
export declare function detectMime(source: unknown, bytes: Uint8Array): string | null;
/** Filename carried by the source, if any (browser File extends Blob with `name`). */
export declare function filenameOf(source: unknown): string | undefined;
//# sourceMappingURL=mime.d.ts.map