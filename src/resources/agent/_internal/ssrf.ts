// SSRF guards for host-side `web_fetch`. Marketplace agents must not probe
// loopback, private networks, or cloud metadata endpoints.

/** True when the hostname is a bare IPv4 literal. */
function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/** Parse a dotted IPv4 string into four octets, or null if invalid. */
function parseIpv4(host: string): [number, number, number, number] | null {
  if (!isIpv4Literal(host)) return null;
  const parts = host.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts as [number, number, number, number];
}

/**
 * True when `host` (lowercased, no brackets) is loopback, RFC1918, link-local,
 * or cloud metadata. Also rejects bare `localhost` and IPv6 loopback/ULA/link-local.
 */
export function isPrivateOrMetadataHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");

  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0") return true;

  // IPv6 loopback / unspecified / link-local / ULA (fc00::/7)
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe80:")) return true;
  if (/^f[cd][0-9a-f]{0,2}:/i.test(h)) return true;
  // Compressed forms that resolve to loopback
  if (h === "0:0:0:0:0:0:0:1" || h === "0000:0000:0000:0000:0000:0000:0000:0001") return true;

  const ip = parseIpv4(h);
  if (!ip) return false;
  const [a, b] = ip;

  // Loopback 127.0.0.0/8
  if (a === 127) return true;
  // RFC1918
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // Link-local 169.254.0.0/16 (includes AWS/GCP/Azure metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // CGNAT 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  // "This" network / broadcast
  if (a === 0) return true;
  if (a === 255 && b === 255 && ip[2] === 255 && ip[3] === 255) return true;

  return false;
}

/**
 * Validate a URL string for `web_fetch`. Returns the parsed URL on success, or
 * an error message suitable for the tool result.
 */
export function assertSafeFetchUrl(
  raw: string,
): { ok: true; url: URL } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `Invalid URL: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `Blocked scheme: ${url.protocol} (only http/https allowed)` };
  }
  if (isPrivateOrMetadataHost(url.hostname)) {
    return {
      ok: false,
      error: `Blocked host: ${url.hostname} (private / metadata addresses are not allowed)`,
    };
  }
  return { ok: true, url };
}
