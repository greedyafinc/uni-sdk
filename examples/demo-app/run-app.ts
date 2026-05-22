// Local-dev launcher for the demo app.
//
// Points the SDK at the locally-running UnifiedAI services:
//   UnifiedApp Web      → http://localhost:9000   (/oauth/authorize consent UI)
//   unified-api         → http://localhost:3141   (/oauth/token PKCE exchange)

const WEB_BASE = process.env.UNIFIEDAI_WEB_BASE ?? "http://localhost:9000";
const API_BASE = process.env.UNIFIEDAI_API_BASE ?? "http://localhost:3141";

process.env.UNIFIEDAI_AUTHORIZE_URL = `${WEB_BASE}/oauth/authorize`;
process.env.UNIFIEDAI_TOKEN_URL = `${API_BASE}/oauth/token`;
process.env.UNIFIEDAI_API_BASE = API_BASE;

console.log(
  `[harness] authorize=${process.env.UNIFIEDAI_AUTHORIZE_URL}  token=${process.env.UNIFIEDAI_TOKEN_URL}  api=${API_BASE}`,
);

await import("./app");
