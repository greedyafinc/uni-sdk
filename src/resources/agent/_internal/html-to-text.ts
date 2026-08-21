// Minimal HTML → readable text for `web_fetch`. No DOM dependency — regex strip
// of scripts/styles/tags, entity decode, whitespace collapse. Good enough for
// feeding page content back into a model context window.

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-zA-Z]+);/g, (match, name: string) => ENTITY_MAP[name.toLowerCase()] ?? match);
}

/**
 * Strip scripts/styles/tags from HTML and return collapsed plain text.
 * `maxChars` truncates the final string (appends a truncation marker).
 */
export function htmlToText(html: string, maxChars = 64_000): string {
  let s = html;
  // Drop non-content blocks first.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Block-level breaks before stripping tags.
  s = s.replace(
    /<\/(p|div|h[1-6]|li|tr|br|hr|blockquote|pre|section|article|header|footer)>/gi,
    "\n",
  );
  s = s.replace(/<(br|hr)\b[^>]*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ");
  s = s.replace(/\n[ \t]+/g, "\n");
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();
  if (s.length > maxChars) {
    return `${s.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]`;
  }
  return s;
}
