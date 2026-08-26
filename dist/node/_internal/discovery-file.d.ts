/** Platform config dir: `%APPDATA%\UnifiedAI` on Windows, `~/.unifiedai` elsewhere. */
export declare function defaultDiscoveryDir(): string;
/**
 * Read + parse + validate a discovery JSON file. Any failure — missing file,
 * unreadable, malformed JSON, failed validation — resolves to null; discovery
 * is always best-effort and the callers fall through to the next source.
 */
export declare function readDiscoveryJson<T>(path: string, isValid: (parsed: unknown) => boolean): Promise<T | null>;
//# sourceMappingURL=discovery-file.d.ts.map