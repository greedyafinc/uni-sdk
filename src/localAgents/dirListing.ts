// Directory listings from the machine on the other end of a transport.
//
// Shared by BOTH transports: the loopback bridge's `POST /list-dir` and the
// relay's `list-dir` frame carry the identical listing shape, so the type and
// its normalizer live here rather than in either client. Browser-safe: plain
// data, no `node:` builtins.

/** One entry in a directory listing from the host machine. */
export interface LocalAgentDirEntry {
  name: string;
  path: string;
  /** Whether this directory is a git repository root. */
  git: boolean;
}

/** A directory listing from the machine the transport talks to. */
export interface LocalAgentDirListing {
  /** The listed directory, or null when the host listed its default root. */
  path: string | null;
  /** The listed directory's parent, or null at a filesystem root. */
  parent: string | null;
  /**
   * The allowed root this listing sits inside, when the host restricts
   * browsing. The picker anchors its breadcrumb here and shows nothing above
   * it. Absent for unrestricted hosts and for the view above several roots.
   */
  root?: string;
  /** The host user's home directory. */
  home: string;
  /** The host's path separator ("/" or "\\"). */
  sep: string;
  entries: LocalAgentDirEntry[];
  /** Host-suggested starting points (recent workspaces, common folders). */
  suggested?: string[];
  /** True when the host cut the listing short. */
  truncated?: boolean;
  /** True when the host refused to descend into the requested path. */
  restricted?: boolean;
}

/** Tolerant parse of a listing off either wire — same spirit as `normalizeDetect`. */
export function normalizeDirListing(value: unknown): LocalAgentDirListing {
  const v = (value ?? {}) as Record<string, unknown>;
  const entries: LocalAgentDirEntry[] = Array.isArray(v.entries)
    ? (v.entries as Array<Record<string, unknown> | null>)
        .filter((e) => !!e && typeof e.name === "string" && typeof e.path === "string")
        .map((e) => ({
          name: e!.name as string,
          path: e!.path as string,
          git: e!.git === true,
        }))
    : [];
  const suggested = Array.isArray(v.suggested)
    ? (v.suggested as unknown[]).filter((s): s is string => typeof s === "string")
    : null;
  return {
    path: typeof v.path === "string" ? v.path : null,
    parent: typeof v.parent === "string" ? v.parent : null,
    home: typeof v.home === "string" ? v.home : "",
    sep: typeof v.sep === "string" ? v.sep : "/",
    entries,
    // Rebuilt field by field, so anything added to the wire must be added here
    // too or it is dropped without a word.
    ...(typeof v.root === "string" && v.root ? { root: v.root } : {}),
    ...(suggested ? { suggested } : {}),
    ...(v.truncated === true ? { truncated: true } : {}),
    ...(v.restricted === true ? { restricted: true } : {}),
  };
}
