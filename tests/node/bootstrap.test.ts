import { describe, expect, test } from "bun:test";
import type { OpenUrl } from "../../src/node/_internal/browser-auth";
import type { DiscoveryReader } from "../../src/node/_internal/discovery";
import type { EnvReader } from "../../src/node/_internal/env";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import { UnifiedAI, UnifiedError } from "../../src/node/index";
import { startFakeDesktop } from "../fake-desktop";
import { startFakeWebAuth } from "../fake-web-auth";

const CLIENT = "app_test";
const USER = "user_test";
const emptyDiscovery: DiscoveryReader = { read: async () => null };
const envWith = (port: number | undefined): EnvReader => ({
  read: () => ({ handoffPort: port, clientId: undefined }),
});

describe("bootstrap", () => {
  test("loads from keychain when present and skips handoff", async () => {
    const desktop = await startFakeDesktop({ knownClientId: CLIENT, userId: USER });
    const keychain = new InMemoryKeychain();
    await keychain.set(CLIENT, {
      access_token: "a",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 60,
      user_id: USER,
      client_id: CLIENT,
    });
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        keychain,
        env: envWith(desktop.port),
        discovery: emptyDiscovery,
      });
      await sdk.bootstrap();
      expect(sdk.identity()).toEqual({ user_id: USER, client_id: CLIENT });
      expect(desktop.requestCount()).toBe(0);
    } finally {
      await desktop.stop();
    }
  });

  test("uses env-var handoff when keychain empty and persists result", async () => {
    const desktop = await startFakeDesktop({ knownClientId: CLIENT, userId: USER });
    const keychain = new InMemoryKeychain();
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        keychain,
        env: envWith(desktop.port),
        discovery: emptyDiscovery,
      });
      await sdk.bootstrap();
      expect(sdk.identity().client_id).toBe(CLIENT);
      expect(desktop.requestCount()).toBe(1);
      expect(await keychain.get(CLIENT)).not.toBeNull();
    } finally {
      await desktop.stop();
    }
  });

  test("uses discovery file when env var absent", async () => {
    const desktop = await startFakeDesktop({ knownClientId: CLIENT, userId: USER });
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        keychain: new InMemoryKeychain(),
        env: envWith(undefined),
        discovery: {
          read: async () => ({ port: desktop.port, pid: 1, started_at: 0 }),
        },
      });
      await sdk.bootstrap();
      expect(sdk.identity().user_id).toBe(USER);
      expect(desktop.requestCount()).toBe(1);
    } finally {
      await desktop.stop();
    }
  });

  test("surfaces app_not_installed when desktop 404s", async () => {
    const desktop = await startFakeDesktop({ knownClientId: "other", userId: USER });
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        keychain: new InMemoryKeychain(),
        env: envWith(desktop.port),
        discovery: emptyDiscovery,
      });
      await expect(sdk.bootstrap()).rejects.toMatchObject({ code: "app_not_installed" });
    } finally {
      await desktop.stop();
    }
  });

  test("falls back to browser PKCE when desktop unreachable", async () => {
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const keychain = new InMemoryKeychain();
    const openUrl: OpenUrl = async (url) => {
      await fetch(url, { redirect: "follow" });
    };
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        keychain,
        env: envWith(undefined),
        discovery: emptyDiscovery,
        authorizeUrl: web.authorizeUrl,
        tokenUrl: web.tokenUrl,
        openUrl,
      });
      await sdk.bootstrap();
      expect(sdk.identity()).toEqual({ user_id: USER, client_id: CLIENT });
      expect(await keychain.get(CLIENT)).not.toBeNull();
    } finally {
      await web.stop();
    }
  });

  test("identity() before bootstrap throws not_bootstrapped", () => {
    const sdk = new UnifiedAI({ appId: CLIENT, keychain: new InMemoryKeychain() });
    expect(() => sdk.identity()).toThrow(UnifiedError);
  });

  test("bootstrap is idempotent: concurrent calls share the same promise", async () => {
    const desktop = await startFakeDesktop({ knownClientId: CLIENT, userId: USER });
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        keychain: new InMemoryKeychain(),
        env: envWith(desktop.port),
        discovery: emptyDiscovery,
      });
      await Promise.all([sdk.bootstrap(), sdk.bootstrap(), sdk.bootstrap()]);
      expect(desktop.requestCount()).toBe(1);
    } finally {
      await desktop.stop();
    }
  });
});
