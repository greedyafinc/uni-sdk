// Page identity from HTML `<head>` — title + logo for citation chips.
// No DOM; scans the first chunk of markup for title/og/icon tags.

import { decodeEntities } from "./html-to-text";

const HEAD_CHARS = 120_000;

export interface HtmlMeta {
  title?: string;
  /** Absolute http(s) URL of the best site logo (apple-touch-icon, icon, og:logo). */
  icon?: string;
}

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  const raw = m?.[1] ?? m?.[2] ?? m?.[3];
  if (raw == null || raw === "") return undefined;
  return decodeEntities(raw.trim());
}

function relTokens(rel: string | undefined): string[] {
  return (rel ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function resolveUrl(href: string, baseUrl: string): string | undefined {
  if (!href || href.startsWith("data:")) return undefined;
  try {
    const u = new URL(href, baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

function collapseTitle(s: string): string {
  return decodeEntities(s)
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function iconRank(rel: string[], type: string | undefined): number {
  const t = (type ?? "").toLowerCase();
  if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")) return 100;
  if (rel.includes("icon") || rel.includes("shortcut")) {
    if (t.includes("svg")) return 80;
    if (t.includes("png") || t.includes("webp")) return 70;
    return 40;
  }
  return 0;
}

/**
 * Pull display title and a site logo from HTML metadata. Looks at `<title>`,
 * `og:title`, `og:logo`, `apple-touch-icon`, and `rel=icon`. `og:image` is
 * skipped — it's usually an article photo, not a logo.
 */
export function extractHtmlMeta(html: string, baseUrl: string): HtmlMeta {
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const head = headMatch?.[1] ?? html.slice(0, HEAD_CHARS);

  let title: string | undefined;
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  if (titleTag?.[1]) title = collapseTitle(titleTag[1]);

  let ogTitle: string | undefined;
  let ogLogo: string | undefined;
  let bestIcon: { href: string; rank: number } | undefined;

  const metaRe = /<meta\b[^>]*>/gi;
  let meta: RegExpExecArray | null = metaRe.exec(head);
  while (meta) {
    const tag = meta[0];
    const prop = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
    const content = attr(tag, "content");
    if (content) {
      if (prop === "og:title" || prop === "twitter:title") ogTitle = collapseTitle(content);
      if (prop === "og:logo") ogLogo = content;
    }
    meta = metaRe.exec(head);
  }

  const linkRe = /<link\b[^>]*>/gi;
  let link: RegExpExecArray | null = linkRe.exec(head);
  while (link) {
    const tag = link[0];
    const rel = relTokens(attr(tag, "rel"));
    const href = attr(tag, "href");
    const rank = iconRank(rel, attr(tag, "type"));
    if (href && rank > 0 && (!bestIcon || rank > bestIcon.rank)) {
      bestIcon = { href, rank };
    }
    link = linkRe.exec(head);
  }

  const iconHref = bestIcon?.href ?? ogLogo;
  const icon = iconHref ? resolveUrl(iconHref, baseUrl) : undefined;
  const resolvedTitle = (ogTitle || title || "").trim() || undefined;
  // Conditional spreads — `exactOptionalPropertyTypes` forbids explicit undefined.
  return { ...(resolvedTitle ? { title: resolvedTitle } : {}), ...(icon ? { icon } : {}) };
}

/** Header lines prepended to `web_fetch` text so hosts can parse citations. */
export function formatFetchMeta(url: string, meta: HtmlMeta): string {
  const lines = [`URL: ${url}`];
  if (meta.title) lines.push(`Title: ${meta.title}`);
  if (meta.icon) lines.push(`Icon: ${meta.icon}`);
  return lines.join("\n");
}
