export interface HtmlMeta {
    title?: string;
    /** Absolute http(s) URL of the best site logo (apple-touch-icon, icon, og:logo). */
    icon?: string;
}
/**
 * Pull display title and a site logo from HTML metadata. Looks at `<title>`,
 * `og:title`, `og:logo`, `apple-touch-icon`, and `rel=icon`. `og:image` is
 * skipped — it's usually an article photo, not a logo.
 */
export declare function extractHtmlMeta(html: string, baseUrl: string): HtmlMeta;
/** Header lines prepended to `web_fetch` text so hosts can parse citations. */
export declare function formatFetchMeta(url: string, meta: HtmlMeta): string;
//# sourceMappingURL=html-meta.d.ts.map