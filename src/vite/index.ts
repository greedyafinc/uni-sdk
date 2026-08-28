// Vite plugin for embedded marketplace apps — import from
// "@unifiedai/sdk/app/vite". Node-only (build tooling); never ship it.
//
// Replaces the externalize/alias plumbing every app's vite.config.ts hand-rolled
// around the `@unified/host-api` bare specifier:
//
//  - BUILD: the specifier is EXTERNALIZED and rewritten to /host-api.js — the
//    host-served forwarder onto window.__UNIFIED_HOST__ — so the host shell
//    provides the bridge and none of the dev shim ships in the remote bundle.
//  - SERVE (standalone dev): the specifier is aliased to this package's
//    dev-host-api module, which stands up a real `UnifiedAI` against the app's
//    dev proxy. `appId` is injected as import.meta.env.VITE_UNIFIED_APP_ID so
//    the shim tags requests with the right app id.
//
// `vite` is an OPTIONAL peer: only the `Plugin` type is imported, so the
// dependency never exists at runtime.

import type { Plugin } from "vite";

/** The specifier every embedded app imports its host bridge from. */
const HOST_API_SPECIFIER = "@unified/host-api";

/** Where a production remote resolves the bridge: served by the host shell,
    relative to the loaded app.js. */
const HOST_API_EXTERNAL = "/host-api.js";

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
export function unifiedApp(opts: UnifiedAppOptions): Plugin {
  const devHostApi = opts.devHostApi ?? "@unifiedai/sdk/app/dev-host-api";
  return {
    name: "unified-app",
    config(_config, { command }) {
      if (command === "build") {
        return {
          build: {
            rollupOptions: {
              external: [HOST_API_SPECIFIER],
              output: {
                paths: { [HOST_API_SPECIFIER]: HOST_API_EXTERNAL },
              },
            },
          },
        };
      }
      return {
        resolve: {
          alias: { [HOST_API_SPECIFIER]: devHostApi },
        },
        // The alias points at SDK *source* in a sibling working tree. Left to
        // itself Vite treats that as a dependency and pre-bundles it into
        // node_modules/.vite/deps, which then goes stale the moment the SDK
        // changes — the app keeps importing a cached copy and silently loses
        // any newly added host-api export (a missing function reads as "this
        // host can't do that" rather than as an error). Keep it unbundled so
        // edits to the shim are picked up on reload.
        optimizeDeps: {
          exclude: [HOST_API_SPECIFIER, devHostApi],
        },
        define: {
          "import.meta.env.VITE_UNIFIED_APP_ID": JSON.stringify(opts.appId),
        },
      };
    },
  };
}
