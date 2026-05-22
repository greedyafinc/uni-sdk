// Demo harness for @unifiedai/sdk bootstrap flow.
// Drives end-to-end scenarios against fake desktop + fake web-auth servers.
//
// Run from repo root:  bun run demo

import { InMemoryKeychain } from "../../src/_internal/keychain";
import {
  type DiscoveryReader,
  type EnvReader,
  type OpenUrl,
  UnifiedAI,
  UnifiedError,
} from "../../src/index";
import { startFakeDesktop } from "./fake-desktop";
import { startFakeWebAuth } from "./fake-web-auth";

const CLIENT_ID = "app_demo";
const USER_ID = "user_demo";

const emptyDiscovery: DiscoveryReader = { read: async () => null };

function envWith(port: number | undefined): EnvReader {
  return { read: () => ({ handoffPort: port, clientId: undefined }) };
}

interface ScenarioResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

const results: ScenarioResult[] = [];
function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

async function scenarioA(): Promise<void> {
  const desktop = await startFakeDesktop({ knownClientId: CLIENT_ID, userId: USER_ID });
  const keychain = new InMemoryKeychain();
  try {
    const sdk = new UnifiedAI({
      appId: CLIENT_ID,
      keychain,
      env: envWith(desktop.port),
      discovery: emptyDiscovery,
    });
    await sdk.bootstrap();
    const id = sdk.identity();
    const ok =
      id.user_id === USER_ID &&
      id.client_id === CLIENT_ID &&
      desktop.requestCount() === 1 &&
      (await keychain.get(CLIENT_ID)) !== null;
    record("A: env handoff populates keychain", ok, JSON.stringify(id));
  } finally {
    await desktop.stop();
  }
}

async function scenarioB(): Promise<void> {
  const desktop = await startFakeDesktop({ knownClientId: CLIENT_ID, userId: USER_ID });
  const keychain = new InMemoryKeychain();
  await keychain.set(CLIENT_ID, {
    access_token: "cached_access",
    refresh_token: "cached_refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user_id: USER_ID,
    client_id: CLIENT_ID,
  });
  try {
    const sdk = new UnifiedAI({
      appId: CLIENT_ID,
      keychain,
      env: envWith(desktop.port),
      discovery: emptyDiscovery,
    });
    await sdk.bootstrap();
    const id = sdk.identity();
    const ok =
      id.user_id === USER_ID && id.client_id === CLIENT_ID && desktop.requestCount() === 0;
    record(
      "B: keychain hit skips desktop",
      ok,
      `desktop hits=${desktop.requestCount()} identity=${JSON.stringify(id)}`,
    );
  } finally {
    await desktop.stop();
  }
}

async function scenarioC(): Promise<void> {
  const desktop = await startFakeDesktop({ knownClientId: "different_app", userId: USER_ID });
  try {
    const sdk = new UnifiedAI({
      appId: CLIENT_ID,
      keychain: new InMemoryKeychain(),
      env: envWith(desktop.port),
      discovery: emptyDiscovery,
    });
    let caught: unknown;
    try {
      await sdk.bootstrap();
    } catch (e) {
      caught = e;
    }
    const ok = caught instanceof UnifiedError && caught.code === "app_not_installed";
    record(
      "C: unknown client_id surfaces app_not_installed",
      ok,
      caught instanceof UnifiedError ? `${caught.name}:${caught.code}` : "no UnifiedError",
    );
  } finally {
    await desktop.stop();
  }
}

async function scenarioD(): Promise<void> {
  const desktop = await startFakeDesktop({ knownClientId: CLIENT_ID, userId: USER_ID });
  try {
    const sdk = new UnifiedAI({
      appId: CLIENT_ID,
      keychain: new InMemoryKeychain(),
      env: envWith(desktop.port),
      discovery: emptyDiscovery,
    });
    await sdk.bootstrap();
    const snapshot = JSON.stringify(sdk, (_k, v) => v);
    const keys = Object.keys(sdk);
    // Probe: any property that returns the raw access/refresh token strings?
    const id = sdk.identity();
    const exposesTokens =
      snapshot.includes("desktop_access_") ||
      snapshot.includes("desktop_refresh_") ||
      JSON.stringify(id).includes("desktop_access_") ||
      keys.some((k) => /^(access|refresh)_token$|^tokens?$/i.test(k));
    record(
      "D: no public path to tokens",
      !exposesTokens,
      `keys=[${keys.join(",")}] identity exposes only {user_id, client_id}`,
    );
  } finally {
    await desktop.stop();
  }
}

async function scenarioE(): Promise<void> {
  const web = await startFakeWebAuth({ userId: USER_ID, expectedClientId: CLIENT_ID });
  const keychain = new InMemoryKeychain();
  const openUrl: OpenUrl = async (url) => {
    // Stand in for "user opens browser" — fetch follows the 302 to loopback.
    await fetch(url, { redirect: "follow" });
  };
  try {
    const sdk = new UnifiedAI({
      appId: CLIENT_ID,
      keychain,
      env: envWith(undefined),
      discovery: emptyDiscovery,
      authorizeUrl: web.authorizeUrl,
      tokenUrl: web.tokenUrl,
      openUrl,
    });
    await sdk.bootstrap();
    const id = sdk.identity();
    const ok =
      id.user_id === USER_ID &&
      id.client_id === CLIENT_ID &&
      (await keychain.get(CLIENT_ID)) !== null;
    record("E: browser PKCE fallback when desktop unreachable", ok, JSON.stringify(id));
  } finally {
    await web.stop();
  }
}

async function main(): Promise<void> {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioE();

  const failed = results.filter((r) => !r.passed).length;
  console.log("");
  console.log(`${results.length - failed}/${results.length} scenarios passed`);
  if (failed > 0) process.exit(1);
}

void main();
