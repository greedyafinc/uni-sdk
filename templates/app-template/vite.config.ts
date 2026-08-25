// Build config for an embedded UnifiedApp app.
//
// `unifiedApp()` wires the `@unified/host-api` bare specifier for both modes:
//  - build: externalized and rewritten to /host-api.js (the host serves the
//    real bridge onto window.__UNIFIED_HOST__);
//  - serve (standalone dev): aliased to the SDK's dev shim, which stands up a
//    real UnifiedAI against the dev proxy below (set VITE_DEV_API_KEY in .env).
//
// Lib mode emits the two entries the manifest names, side by side:
//  - app.js    — the mounted UI (manifest `module`)
//  - search.js — the search provider (manifest `search.entry`), a separate
//    chunk the host imports lazily, without the UI.
// Everything else — Vue included — is bundled; only @unified/host-api stays
// external. (An app that ships CSS should mirror the docs app's inject-link
// pattern — lib mode extracts CSS to a file that nothing loads by itself.
// This template keeps its styles inline to stay out of that business.)
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { unifiedApp } from "@unifiedai/sdk/app/vite";

export default defineConfig({
  plugins: [vue(), unifiedApp({ appId: "my-app" })],
  build: {
    lib: {
      entry: {
        app: "src/entry.ts",
        search: "src/search.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
  },
  // Standalone dev only: proxy the model surface to unified-api so the dev
  // host-api shim's relative `/api/v1/*` requests reach a real gateway.
  server: {
    proxy: {
      "/api/v1": {
        target: process.env.VITE_UNIFIED_API_URL || "http://localhost:3141",
        changeOrigin: true,
      },
    },
  },
});
