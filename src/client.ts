import {
  type LoopbackServer,
  type OpenUrl,
  runBrowserPkce,
} from "./_internal/browser-auth";
import {
  createDefaultDiscoveryReader,
  type DiscoveryReader,
} from "./_internal/discovery";
import { defaultEnvReader, type EnvReader } from "./_internal/env";
import { requestHandoff } from "./_internal/handoff";
import {
  createDefaultKeychain,
  type KeychainAdapter,
} from "./_internal/keychain";
import { createNodeLoopback } from "./_internal/loopback";
import { defaultOpenUrl } from "./_internal/open-url";
import type { TokenSet } from "./_internal/tokens";
import { Core, type CoreOptions } from "./core";
import { UnifiedError } from "./errors";
import type { Identity } from "./identity";

const DEFAULT_AUTHORIZE_URL = "https://web.unifiedai.app/oauth/authorize";
const DEFAULT_TOKEN_URL = "https://api.unifiedai.app/oauth/token";

export interface UnifiedAIOptions extends CoreOptions {
  authorizeUrl?: string;
  tokenUrl?: string;
  env?: EnvReader;
  discovery?: DiscoveryReader;
  keychain?: KeychainAdapter;
  openUrl?: OpenUrl;
  loopback?: LoopbackServer;
}

const tokenStore = new WeakMap<UnifiedAI, TokenSet>();

export class UnifiedAI extends Core {
  private readonly authorizeUrl: string;
  private readonly tokenUrl: string;
  private readonly env: EnvReader;
  private readonly discovery: DiscoveryReader;
  private readonly keychain: KeychainAdapter;
  private readonly openUrl: OpenUrl;
  private readonly loopback: LoopbackServer;
  private bootstrapPromise: Promise<void> | undefined;

  constructor(options: UnifiedAIOptions = {}) {
    super(options);
    this.authorizeUrl =
      options.authorizeUrl ?? process.env.UNIFIEDAI_AUTHORIZE_URL ?? DEFAULT_AUTHORIZE_URL;
    this.tokenUrl =
      options.tokenUrl ?? process.env.UNIFIEDAI_TOKEN_URL ?? DEFAULT_TOKEN_URL;
    this.env = options.env ?? defaultEnvReader;
    this.discovery = options.discovery ?? createDefaultDiscoveryReader();
    this.keychain = options.keychain ?? createDefaultKeychain();
    this.openUrl = options.openUrl ?? defaultOpenUrl;
    this.loopback = options.loopback ?? createNodeLoopback();
  }

  bootstrap(): Promise<void> {
    if (!this.bootstrapPromise) {
      this.bootstrapPromise = this.doBootstrap().catch((err) => {
        this.bootstrapPromise = undefined;
        throw err;
      });
    }
    return this.bootstrapPromise;
  }

  identity(): Identity {
    const t = tokenStore.get(this);
    if (!t) {
      throw new UnifiedError("not_bootstrapped", "call bootstrap() before identity()");
    }
    return { user_id: t.user_id, client_id: t.client_id };
  }

  async signOut(): Promise<void> {
    tokenStore.delete(this);
    this.bootstrapPromise = undefined;
    let clientId: string;
    try {
      clientId = this.resolveClientId();
    } catch {
      return;
    }
    try {
      await this.keychain.clear(clientId);
    } catch (err) {
      if (err instanceof UnifiedError && err.code === "keychain_unavailable") return;
      throw err;
    }
  }

  private async doBootstrap(): Promise<void> {
    const clientId = this.resolveClientId();

    const cached = await this.keychain.get(clientId);
    if (cached) {
      tokenStore.set(this, cached);
      return;
    }

    const envSnapshot = this.env.read();
    if (envSnapshot.handoffPort !== undefined) {
      const tokens = await this.tryHandoff(envSnapshot.handoffPort, clientId);
      if (tokens) {
        await this.persist(clientId, tokens);
        return;
      }
    }

    const disc = await this.discovery.read();
    if (disc) {
      const tokens = await this.tryHandoff(disc.port, clientId);
      if (tokens) {
        await this.persist(clientId, tokens);
        return;
      }
    }

    const tokens = await runBrowserPkce({
      clientId,
      authorizeUrl: this.authorizeUrl,
      tokenUrl: this.tokenUrl,
      fetch: this.options.fetch,
      openUrl: this.openUrl,
      loopback: this.loopback,
    });
    await this.persist(clientId, tokens);
  }

  private resolveClientId(): string {
    const configured = this.options.appId;
    if (configured) return configured;
    const fromEnv = this.env.read().clientId;
    if (fromEnv) return fromEnv;
    throw new UnifiedError(
      "not_bootstrapped",
      "appId is required (set it in UnifiedAIOptions or via UNIFIEDAI_CLIENT_ID)",
    );
  }

  private async tryHandoff(port: number, clientId: string): Promise<TokenSet | null> {
    try {
      return await requestHandoff({ port, clientId, fetch: this.options.fetch });
    } catch (err) {
      if (err instanceof UnifiedError && err.code === "handoff_unreachable") {
        return null;
      }
      throw err;
    }
  }

  private async persist(clientId: string, tokens: TokenSet): Promise<void> {
    tokenStore.set(this, tokens);
    try {
      await this.keychain.set(clientId, tokens);
    } catch (err) {
      if (err instanceof UnifiedError && err.code === "keychain_unavailable") {
        return;
      }
      throw err;
    }
  }
}
