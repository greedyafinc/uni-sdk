import { type TokenSet, isTokenSet } from "../../core/_internal/tokens";
import { UnifiedError } from "../../core/errors";

export interface KeychainAdapter {
  get(clientId: string): Promise<TokenSet | null>;
  set(clientId: string, tokens: TokenSet): Promise<void>;
  clear(clientId: string): Promise<void>;
}

const SERVICE = "com.unifiedai.sdk";

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}

interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
}

let loaded: KeyringModule | null = null;
async function loadKeyring(): Promise<KeyringModule> {
  if (loaded) return loaded;
  try {
    loaded = (await import("@napi-rs/keyring")) as unknown as KeyringModule;
    return loaded;
  } catch {
    throw new UnifiedError("keychain_unavailable", "OS keychain module not available");
  }
}

export function createDefaultKeychain(): KeychainAdapter {
  return {
    async get(clientId) {
      const { Entry } = await loadKeyring();
      const entry = new Entry(SERVICE, clientId);
      let raw: string | null;
      try {
        raw = entry.getPassword();
      } catch {
        return null;
      }
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        return isTokenSet(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async set(clientId, tokens) {
      const { Entry } = await loadKeyring();
      new Entry(SERVICE, clientId).setPassword(JSON.stringify(tokens));
    },
    async clear(clientId) {
      const { Entry } = await loadKeyring();
      try {
        new Entry(SERVICE, clientId).deletePassword();
      } catch {
        // ignore
      }
    },
  };
}

export class InMemoryKeychain implements KeychainAdapter {
  private readonly store = new Map<string, TokenSet>();
  async get(clientId: string): Promise<TokenSet | null> {
    return this.store.get(clientId) ?? null;
  }
  async set(clientId: string, tokens: TokenSet): Promise<void> {
    this.store.set(clientId, tokens);
  }
  async clear(clientId: string): Promise<void> {
    this.store.delete(clientId);
  }
}
