import type { Core } from "../../core/core.js";
import type { FsBackend, FsEntry, FsStat, FsWriteReq } from "./types.js";
export declare class CloudFsBackend implements FsBackend {
    private readonly client;
    readonly name = "cloud-fs";
    constructor(client: Core);
    private post;
    available(): boolean;
    read(ns: string, path: string): Promise<Uint8Array | null>;
    write(req: FsWriteReq): Promise<void>;
    list(ns: string, prefix?: string): Promise<FsEntry[]>;
    stat(ns: string, path: string): Promise<FsStat | null>;
    delete(ns: string, path: string): Promise<boolean>;
}
//# sourceMappingURL=cloud.d.ts.map