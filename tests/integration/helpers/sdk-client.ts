import { UnifiedAI } from "../../../src/core/client";
import { startRecorder } from "./recorder";
import { startReplayServer } from "./replay-server";

export const RECORD = process.env.RECORD === "true";
export const UPSTREAM = process.env.UNIFIEDAI_API_URL ?? "http://127.0.0.1:3141";

/**
 * When unified-api runs with BYPASS_AUTH=true the bearer header is ignored, so
 * the literal value here is just a non-empty placeholder. In replay mode the
 * cassette server doesn't read it either.
 */
const PLACEHOLDER_TOKEN = "bypass";

export interface IntegrationHarness {
  sdk: UnifiedAI;
  /** Load cassette for replay mode, or start recording for record mode. */
  cassette: (name: string) => void;
  /** Persist the cassette (record mode only; no-op in replay). */
  flush: () => void;
  /** Requests served from the replay queue (replay mode only). */
  requests: () => Array<{ method: string; path: string; body: unknown }>;
  stop: () => Promise<void>;
}

async function assertUpstreamReady(): Promise<void> {
  try {
    // Probe an authed endpoint with a minimal payload so BYPASS_AUTH=false
    // surfaces as a 401 here rather than mid-test. The body is intentionally
    // small/cheap; we only inspect the status code.
    const res = await fetch(`${UPSTREAM}/api/v1/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${PLACEHOLDER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: "" }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `unified-api at ${UPSTREAM} rejected the request (status ${res.status}). Start it with BYPASS_AUTH=true so integration tests don't need a real token:\n  cd ../unified-api && BYPASS_AUTH=true bun run dev`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("BYPASS_AUTH")) throw err;
    throw new Error(
      `Cannot reach unified-api at ${UPSTREAM}. Start it in another terminal:\n  cd ../unified-api && BYPASS_AUTH=true bun run dev\nOverride the URL with UNIFIEDAI_API_URL if it's running elsewhere.`,
    );
  }
}

export async function startIntegrationHarness(): Promise<IntegrationHarness> {
  if (RECORD) {
    await assertUpstreamReady();
    const recorder = await startRecorder({ upstream: UPSTREAM });
    const sdk = new UnifiedAI({
      apiUrl: recorder.baseUrl,
      token: PLACEHOLDER_TOKEN,
    });
    return {
      sdk,
      cassette: (name) => recorder.start(name),
      flush: () => recorder.flush(),
      requests: () => [],
      stop: () => recorder.stop(),
    };
  }

  const replay = await startReplayServer();
  const sdk = new UnifiedAI({
    apiUrl: replay.baseUrl,
    token: PLACEHOLDER_TOKEN,
  });
  return {
    sdk,
    cassette: (name) => replay.use(name),
    flush: () => {},
    requests: () => replay.requests(),
    stop: () => replay.stop(),
  };
}
