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
export declare function normalizeDirListing(value: unknown): LocalAgentDirListing;
//# sourceMappingURL=dirListing.d.ts.map