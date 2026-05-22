// Local-dev launcher for the demo app.
//
// Points the SDK at the locally-running UnifiedAI services:
//   UnifiedApp Web      → http://localhost:9000   (/oauth/authorize consent UI)
//   unified-api         → http://localhost:3141   (/oauth/token PKCE exchange)
//
// The SDK does not talk to base-api directly — base-api sits behind the
// access token for normal API calls after auth completes.
//
// Desktop handoff (UNI-72) isn't implemented yet, so the SDK falls through
// to the browser PKCE path against real services. To exercise the handoff
// path against a local sim instead, set UNIFIEDAI_USE_DESKTOP_SIM=1.

import { APP_ID } from "./constants";
import { ensureAppInstalled, ensureDesktopSession, startDesktopServer } from "./desktop-sim";

const WEB_BASE = process.env.UNIFIEDAI_WEB_BASE ?? "http://localhost:9000";
const API_BASE = process.env.UNIFIEDAI_API_BASE ?? "http://localhost:3141";

async function main(): Promise<void> {
  process.env.UNIFIEDAI_AUTHORIZE_URL = `${WEB_BASE}/oauth/authorize`;
  process.env.UNIFIEDAI_TOKEN_URL = `${API_BASE}/oauth/token`;

  let stopDesktop: (() => Promise<void>) | undefined;
  if (process.env.UNIFIEDAI_USE_DESKTOP_SIM === "1") {
    await ensureDesktopSession();
    ensureAppInstalled(APP_ID);
    const desktop = await startDesktopServer({ quiet: false });
    process.env.UNIFIEDAI_HANDOFF_PORT = String(desktop.port);
    stopDesktop = () => desktop.stop();
    console.log(`[harness] desktop-sim listening on :${desktop.port}`);
  }

  console.log(
    `[harness] authorize=${process.env.UNIFIEDAI_AUTHORIZE_URL}  token=${process.env.UNIFIEDAI_TOKEN_URL}`,
  );

  try {
    await import("./basic-app");
  } finally {
    await stopDesktop?.();
  }
}

void main();
