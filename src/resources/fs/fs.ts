// `sdk.fs` — the app-namespaced file workspace facade over a swappable
// FsBackend. The sibling of `sdk.storage`: the app (and the agent loop running
// on its behalf) reads/writes/edits a jailed directory tree. The facade owns
// utf8 encode/decode, the read-modify-write `edit()`, the read-only guard, and
// path normalization; the backend is the server-backed Cloud workspace
// (unified-api → Supabase) whenever a token is configured, or a host-injected
// one via `UnifiedAIOptions.fs`. With no token and nothing injected, `sdk.fs`
// is unavailable — there is no local browser (OPFS) fallback.
//
// `edit()` is implemented HERE (read → unique-replace → write), exactly like
// OpenDesign's `unified-agent.ts` `edit_file` tool, so porting that loop onto
// `sdk.fs` is a direct mapping. See docs/capability-platform.md.
import type { Core } from "../../core/core";
import {
  BackendResolver,
  assertWritableNamespace,
  deriveNamespace,
  requireAvailableBackend,
} from "../_kv/namespace";
import { CloudFsBackend } from "./cloud";
import { fsError } from "./errors";
import { normalizePrefix, normalizeRelPath } from "./path";
import type {
  FsBackend,
  FsEntry,
  FsListOptions,
  FsNamespace,
  FsNamespaceMode,
  FsNamespaceOptions,
  FsStat,
} from "./types";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

class FsNamespaceImpl implements FsNamespace {
  constructor(
    private readonly backend: FsBackend | null,
    readonly id: string,
    readonly mode: FsNamespaceMode,
  ) {}

  private requireBackend(): FsBackend {
    return requireAvailableBackend(this.backend, "fs");
  }

  private assertWritable(): void {
    assertWritableNamespace(this.mode, this.id, "fs");
  }

  async read(path: string): Promise<string> {
    return utf8Decoder.decode(await this.readBytes(path));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const backend = this.requireBackend();
    const rel = normalizeRelPath(path);
    const bytes = await backend.read(this.id, rel);
    if (bytes === null) throw fsError("not_found", `no such file: "${rel}"`);
    return bytes;
  }

  async write(path: string, content: string | Uint8Array): Promise<void> {
    this.assertWritable();
    const backend = this.requireBackend();
    const rel = normalizeRelPath(path);
    const bytes = typeof content === "string" ? utf8Encoder.encode(content) : content;
    await backend.write({ ns: this.id, path: rel, bytes });
  }

  async edit(path: string, oldString: string, newString: string): Promise<void> {
    this.assertWritable();
    const backend = this.requireBackend();
    const rel = normalizeRelPath(path);
    const existing = await backend.read(this.id, rel);
    if (existing === null) throw fsError("edit_not_found", `no such file: "${rel}"`);
    const text = utf8Decoder.decode(existing);
    const first = text.indexOf(oldString);
    if (first === -1) {
      throw fsError("edit_not_found", `old_string not found in "${rel}"`);
    }
    if (oldString && text.indexOf(oldString, first + oldString.length) !== -1) {
      throw fsError(
        "edit_not_unique",
        `old_string is not unique in "${rel}"; include more surrounding context`,
      );
    }
    const next = text.slice(0, first) + newString + text.slice(first + oldString.length);
    await backend.write({ ns: this.id, path: rel, bytes: utf8Encoder.encode(next) });
  }

  async list(opts: FsListOptions = {}): Promise<FsEntry[]> {
    const backend = this.requireBackend();
    const prefix = normalizePrefix(opts.prefix);
    const entries = await backend.list(this.id, prefix || undefined);
    // Sort here so every backend returns identical, stable ordering — backends
    // may or may not sort internally, so doing it once in the facade
    // guarantees cross-runtime parity.
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return entries;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }

  async stat(path: string): Promise<FsStat | null> {
    const backend = this.requireBackend();
    const rel = normalizeRelPath(path);
    return backend.stat(this.id, rel);
  }

  async delete(path: string): Promise<boolean> {
    this.assertWritable();
    const backend = this.requireBackend();
    const rel = normalizeRelPath(path);
    return backend.delete(this.id, rel);
  }
}

/**
 * Local-first, app-namespaced file workspace. Reached as `sdk.fs`.
 *
 * `namespace()` opens the calling app's own (read-write) jailed tree; the id is
 * derived from the client's `appId` (host-stamped per app). `namespace("other-
 * app", { mode: "read" })` names another app's tree — a future broker will gate
 * cross-app access with a user-granted capability at the trusted boundary; today
 * the `ns` is cooperative and the read-only `mode` is enforced only here.
 */
export class Fs {
  // Shared resolution machinery: injected backend wins → server-capable clients
  // get a lazily-built (cached) CloudFsBackend → null (Supabase-only; there is
  // no local OPFS fallback).
  private readonly resolver: BackendResolver<FsBackend>;

  constructor(private readonly client: Core) {
    this.resolver = new BackendResolver(
      () => client.fsBackend,
      () => client.serverCapable,
      () => new CloudFsBackend(client),
    );
  }

  /** Whether a usable fs backend exists in the current runtime. */
  available(): boolean {
    return this.resolver.available();
  }

  /** Open a namespace handle (defaults to the calling app's own workspace). */
  namespace(appId?: string, opts: FsNamespaceOptions = {}): FsNamespace {
    const { id, mode } = deriveNamespace(this.client.appId, appId, opts.mode);
    return new FsNamespaceImpl(this.resolver.resolve(), id, mode);
  }
}
