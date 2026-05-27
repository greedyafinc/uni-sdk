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
export function parseContentDispositionFilename(header: string | undefined): string | undefined {
  if (!header) return undefined;

  // Try RFC 5987 `filename*=charset'lang'percent-encoded-value` first.
  // The `*` marker is the canonical signal that the value is UTF-8 encoded.
  const extended = /filename\*\s*=\s*([^']+)'([^']*)'([^;]+)/i.exec(header);
  if (extended) {
    const value = extended[3]?.trim();
    if (value) {
      try {
        return decodeURIComponent(value);
      } catch {
        // Malformed percent-encoding — fall through to legacy form.
      }
    }
  }

  // Fall back to legacy `filename="..."` or `filename=bare-token`. Anchor on
  // a word boundary so this doesn't match the tail of `filename*=`.
  const legacy = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/i.exec(header);
  if (legacy) {
    const raw = legacy[1] ?? legacy[2];
    if (raw) return raw.replace(/\\(.)/g, "$1"); // unescape backslashes inside quotes
  }
  return undefined;
}
