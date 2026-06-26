// Default browser backend for `sdk.fs`, built on the Origin Private File System
// (OPFS: `navigator.storage.getDirectory()`). The OPFS analog of storage's
// IndexedDbBackend — each namespace is a top-level directory under the origin's
// private root, and files live at their relative paths inside it.
//
// Browser-safe: no `node:*`. Constructed lazily by the facade only when OPFS is
// present, so importing the SDK in a non-OPFS runtime never touches it.
import { fsError } from "./errors";
import { normalizeNs } from "./path";
import type { FsBackend, FsEntry, FsStat, FsWriteReq } from "./types";

// Minimal structural view of the OPFS handles we use, so the file type-checks
// even on TS lib targets that predate the FileSystem Access types.
interface DirHandle {
  kind: "directory";
  name: string;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterableIterator<DirHandle | FileHandle>;
}
interface FileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<{ size: number; lastModified: number; arrayBuffer(): Promise<ArrayBuffer> }>;
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }>;
}

function opfsRoot(): Promise<DirHandle> {
  const nav = globalThis.navigator as unknown as {
    storage?: { getDirectory?: () => Promise<DirHandle> };
  };
  const getDir = nav?.storage?.getDirectory;
  if (!getDir) throw fsError("fs_unavailable", "OPFS is not available in this runtime");
  return getDir.call(nav.storage);
}

export class OpfsBackend implements FsBackend {
  readonly name = "opfs";

  available(): boolean {
    const nav = globalThis.navigator as unknown as {
      storage?: { getDirectory?: unknown };
    };
    return typeof nav?.storage?.getDirectory === "function";
  }

  /** Resolve the directory handle that holds `path`'s file, optionally creating dirs. */
  private async dirFor(
    nsDir: string,
    path: string,
    create: boolean,
  ): Promise<{ dir: DirHandle; file: string } | null> {
    const segments = path.split("/");
    const file = segments.pop() as string;
    let dir = await opfsRoot();
    try {
      dir = await dir.getDirectoryHandle(nsDir, { create });
      for (const seg of segments) {
        dir = await dir.getDirectoryHandle(seg, { create });
      }
    } catch {
      // A missing intermediate dir on a non-creating walk → the file can't exist.
      return null;
    }
    return { dir, file };
  }

  async read(ns: string, path: string): Promise<Uint8Array | null> {
    const loc = await this.dirFor(normalizeNs(ns), path, false);
    if (!loc) return null;
    try {
      const handle = await loc.dir.getFileHandle(loc.file, { create: false });
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async write(req: FsWriteReq): Promise<void> {
    const loc = await this.dirFor(normalizeNs(req.ns), req.path, true);
    // dirFor with create:true never returns null, but guard for the type.
    if (!loc) throw fsError("fs_unavailable", "could not resolve directory for write");
    const handle = await loc.dir.getFileHandle(loc.file, { create: true });
    const writable = await handle.createWritable();
    await writable.write(req.bytes);
    await writable.close();
  }

  async list(ns: string, prefix?: string): Promise<FsEntry[]> {
    const nsDir = normalizeNs(ns);
    let base: DirHandle;
    try {
      base = await (await opfsRoot()).getDirectoryHandle(nsDir, { create: false });
    } catch {
      return [];
    }
    const out: FsEntry[] = [];
    const walk = async (dir: DirHandle, rel: string): Promise<void> => {
      for await (const entry of dir.values()) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.kind === "directory") {
          await walk(entry, childRel);
        } else {
          const f = await entry.getFile();
          out.push({ path: childRel, size: f.size, updatedAt: f.lastModified });
        }
      }
    };
    // Descend to the prefix dir first when one is given.
    let start = base;
    let startRel = "";
    if (prefix) {
      try {
        for (const seg of prefix.split("/")) {
          start = await start.getDirectoryHandle(seg, { create: false });
        }
        startRel = prefix;
      } catch {
        return [];
      }
    }
    await walk(start, startRel);
    return out;
  }

  async stat(ns: string, path: string): Promise<FsStat | null> {
    const loc = await this.dirFor(normalizeNs(ns), path, false);
    if (!loc) return null;
    try {
      const handle = await loc.dir.getFileHandle(loc.file, { create: false });
      const f = await handle.getFile();
      return { path, size: f.size, updatedAt: f.lastModified };
    } catch {
      return null;
    }
  }

  async delete(ns: string, path: string): Promise<boolean> {
    const loc = await this.dirFor(normalizeNs(ns), path, false);
    if (!loc) return false;
    try {
      await loc.dir.removeEntry(loc.file);
      return true;
    } catch {
      return false;
    }
  }
}
