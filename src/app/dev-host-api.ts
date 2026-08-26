// Standalone-dev implementation of `@unified/host-api`, used only when an
// embedded app runs on its own via `vite dev` (outside the UnifiedApp shell).
// The `unifiedApp` Vite plugin ("@unifiedai/sdk/app/vite") aliases the
// `@unified/host-api` specifier here in serve; in a production build the
// specifier is externalized to /host-api.js instead, so none of this ships in
// the bundle.
//
// Generic — no app-specific behavior. It mirrors the host's own bridge so the
// app exercises a REAL uni-sdk instance against unified-api through the app's
// dev proxy, not a mock:
//  - `getSdk()` builds a `UnifiedAI` with relative URLs (`/api/v1/*`) and the
//    dev `uapi_` key from VITE_DEV_API_KEY in the app's .env. The app id comes
//    from VITE_UNIFIED_APP_ID, which the `unifiedApp` plugin defines from its
//    `appId` option.
//  - Theme resolves from the OS preference (there is no host shell setting
//    <html data-theme> — though data-theme is still honored if a dev tool sets
//    it).
//  - `registerActions` is a no-op (there is no host shell to invoke actions),
//    and the local-agent bridge reports itself absent so callers take their
//    documented fallbacks; `runAgent` throws rather than silently doing
//    something different from what it does when embedded.

import { UnifiedAI } from "../core/client";
import type { ProjectContext } from "../host-api";
import { fsTools } from "../resources/agent/fs-tools";
import { getProviderLogo } from "../resources/logos";

/** Vite-injected env, read defensively so this module also loads (for its
    no-ops) under plain bundler-less tooling where import.meta.env is absent. */
const env: Record<string, string | undefined> =
  (import.meta as { env?: Record<string, string | undefined> }).env ?? {};

let sdk: UnifiedAI | null = null;

export function getSdk(): UnifiedAI {
  if (!sdk) {
    const devApiKey = env.VITE_DEV_API_KEY;
    if (!devApiKey) {
      throw new Error(
        "VITE_DEV_API_KEY is not set. Copy .env.example to .env and add your dev uapi_ key.",
      );
    }
    sdk = new UnifiedAI({
      // Empty apiUrl keeps requests relative (`/api/v1/*`) so the Vite dev
      // proxy routes them to unified-api.
      apiUrl: "",
      token: () => devApiKey,
      appId: env.VITE_UNIFIED_APP_ID || "dev-app",
      fetch: ((input, init) => fetch(input, { ...init, credentials: "include" })) as typeof fetch,
    });
  }
  return sdk;
}

// The real fsTools — the host bridge delegates to this same SDK function, so
// standalone dev exercises the canonical tool spec rather than a stub.
export { getProviderLogo, fsTools };

function readTheme(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getTheme(): "light" | "dark" {
  return readTheme();
}

export function onThemeChange(cb: (theme: "light" | "dark") => void): () => void {
  cb(readTheme());
  const media = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  const onMedia = () => cb(readTheme());
  media?.addEventListener("change", onMedia);
  const observer = new MutationObserver(() => cb(readTheme()));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => {
    media?.removeEventListener("change", onMedia);
    observer.disconnect();
  };
}

// Standalone dev has no host shell to invoke actions, so registration is a
// no-op. The real bridge (public/host-api.js → window.__UNIFIED_HOST__)
// replaces this module when the app runs inside UnifiedApp.
export function registerActions(
  _handlers: Record<string, (params: Record<string, unknown>, ctx: unknown) => unknown>,
): () => void {
  return () => {};
}

// ── Local agent providers (Cursor, Claude Code) ────────────────────────────
// Standalone dev has no desktop host, so there is no local-CLI lane to reach:
// `hasRunAgent()` is false, callers fall back to the SDK's own agent loop, and
// no model is ever reported as local. `runAgent` throws rather than silently
// doing something different from what it does when embedded.

export function runAgent(): never {
  throw new Error(
    "@unified/host-api: runAgent is unavailable in standalone dev — open this app inside UnifiedApp",
  );
}

export function hasRunAgent(): boolean {
  return false;
}

export function listModels(): Promise<null> {
  return Promise.resolve(null);
}

export function isLocalAgentModel(): boolean {
  return false;
}

// ── Host conveniences without a host ────────────────────────────────────────
// These mirror the bridge's documented "host too old / no host" fallbacks, so
// standalone dev behaves exactly like an old host and callers take the same
// degradation paths they would ship with.

/** No host usage source in standalone dev — callers fall back to `getSdk().usage`. */
export function getUsage(): Promise<null> {
  return Promise.resolve(null);
}

/** No project context in standalone dev. */
export function getCurrentProject(): ProjectContext | null {
  return null;
}

/**
 * Fires once with `null` (the bridge fires immediately with the current
 * context, which standalone dev never has) and never again; the unsubscribe
 * is a no-op.
 */
export function onProjectChange(cb: (project: ProjectContext | null) => void): () => void {
  cb(null);
  return () => {};
}

/**
 * Resolves to null — the bridge's "there is no shell" outcome — so apps take
 * their documented fallback and surface the artifact in their own UI.
 */
export function openArtifact(): Promise<null> {
  return Promise.resolve(null);
}
