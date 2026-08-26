import type { UploadProgressListener } from "../core.js";
/**
 * Emit an upload-progress event without letting a throwing listener tear down
 * the upload. Host UI bugs must not abort an otherwise-healthy request.
 *
 * Shared by both upload paths — single-shot multipart (`core/client.ts`) and
 * chunked/resumable (`resources/_internal/chunkedUpload.ts`) — so the public
 * `UploadProgressEvent` contract (`percent` is `0..100`, rounded down; `0`
 * when `total` is unknown/`0`) stays identical across them.
 */
export declare function safeEmit(listener: UploadProgressListener | undefined, loaded: number, total: number): void;
//# sourceMappingURL=progress.d.ts.map