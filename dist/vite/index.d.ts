import type { Plugin } from "vite";
export interface UnifiedAppOptions {
    /** The app's manifest id (e.g. "docs"). Injected into standalone dev as
        import.meta.env.VITE_UNIFIED_APP_ID for the dev host-api shim. */
    appId: string;
    /** Module specifier to alias `@unified/host-api` to in serve. Defaults to
        this package's generic shim; point it at your own file to customize
        standalone-dev behavior. */
    devHostApi?: string;
}
/**
 * Wire `@unified/host-api` for an embedded app: external + rewritten to
 * /host-api.js in build, aliased to a standalone-dev shim in serve.
 *
 * Returned config is MERGED into the app's own (Vite `mergeConfig` semantics:
 * `external` arrays concatenate, `output.paths` objects merge), so an app that
 * already externalizes e.g. `vue` keeps doing so.
 */
export declare function unifiedApp(opts: UnifiedAppOptions): Plugin;
//# sourceMappingURL=index.d.ts.map