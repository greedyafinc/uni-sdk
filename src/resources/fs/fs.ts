// `sdk.fs` — the app-namespaced file workspace facade over a swappable
// FsBackend. The sibling of `sdk.storage`: the app (and the agent loop running
// on its behalf) reads/writes/edits a jailed directory tree. The facade owns
// utf8 encode/decode, the read-modify-write `edit()`, the read-only guard, and
// path normalization; the default backend is the browser's OPFS, and a host
// injects a disk-backed one via `UnifiedAIOptions.fs`.
//
// `edit()` is implemented HERE (read → unique-replace → write), exactly like
// OpenDesign's `unified-agent.ts` `edit_file` tool, so porting that loop onto
// `sdk.fs` is a direct mapping. See docs/capability-platform.md.
import type { Core } from "../../core/core";
import { fsError } from "./errors";
import { OpfsBackend } from "./opfs";
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

// One process-wide default OPFS backend, created lazily so importing the SDK in
// a non-OPFS runtime never touches `navigator.storage`. `null` means "no local
// backend here" (e.g. Node without a host-injected backend).
let cachedDefault: FsBackend | null | undefined;
function defaultBackend(): FsBackend | null {
  if (cachedDefault === undefined) {
    const b = new OpfsBackend();
    cachedDefault = b.available() ? b : null;
  }
  return cachedDefault;
}

class FsNamespaceImpl implements FsNamespace {
  constructor(
    private readonly backend: FsBackend | null,
    readonly id: string,
    readonly mode: FsNamespaceMode,
  ) {}

  private requireBackend(): FsBackend {
    if (!this.backend || !this.backend.available()) {
      throw fsError("fs_unavailable", "no fs backend is available in this runtime");
    }
    return this.backend;
  }

  private assertWritable(): void {
    if (this.mode === "read") {
      throw fsError("fs_read_only", `namespace "${this.id}" is read-only`);
    }
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
    // Sort here so every backend returns identical, stable ordering — the host
    // backend sorts internally but OPFS yields raw iteration order, so doing it
    // once in the facade guarantees cross-runtime parity.
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
  constructor(private readonly client: Core) {}

  private resolveBackend(): FsBackend | null {
    return this.client.fsBackend ?? defaultBackend();
  }

  /** Whether a usable fs backend exists in the current runtime. */
  available(): boolean {
    const b = this.resolveBackend();
    return !!b && b.available();
  }

  /** Open a namespace handle (defaults to the calling app's own workspace). */
  namespace(appId?: string, opts: FsNamespaceOptions = {}): FsNamespace {
    const own = (this.client.appId || "").trim() || "default";
    const target = appId?.trim() || own;
    const crossApp = target !== own;
    const mode: FsNamespaceMode = opts.mode ?? (crossApp ? "read" : "readwrite");
    return new FsNamespaceImpl(this.resolveBackend(), target, mode);
  }
}
