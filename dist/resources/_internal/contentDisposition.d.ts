/**
 * Parse the filename out of a Content-Disposition header per RFC 6266 / 5987.
 *
 * Preference order matches RFC 6266 §4.3: when both `filename*` (RFC 5987,
 * percent-encoded UTF-8) and `filename` (legacy ASCII) are present, the
 * `filename*` value wins. Returns the decoded UTF-8 string, or `undefined`
 * if no filename parameter is present or decoding fails.
 *
 * Not part of the public SDK surface — imported only by `files.content()`
 * and the corresponding unit tests.
 */
export declare function parseContentDispositionFilename(header: string | undefined): string | undefined;
//# sourceMappingURL=contentDisposition.d.ts.map