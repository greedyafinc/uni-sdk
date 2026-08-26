/**
 * True when `host` (lowercased, no brackets) is loopback, RFC1918, link-local,
 * or cloud metadata. Also rejects bare `localhost` and IPv6 loopback/ULA/link-local.
 */
export declare function isPrivateOrMetadataHost(host: string): boolean;
/**
 * Validate a URL string for `web_fetch`. Returns the parsed URL on success, or
 * an error message suitable for the tool result.
 */
export declare function assertSafeFetchUrl(raw: string): {
    ok: true;
    url: URL;
} | {
    ok: false;
    error: string;
};
//# sourceMappingURL=ssrf.d.ts.map