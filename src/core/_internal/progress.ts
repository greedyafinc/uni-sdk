import type { UploadProgressListener } from "../core";

/**
 * Emit an upload-progress event without letting a throwing listener tear down
 * the upload. Host UI bugs must not abort an otherwise-healthy request.
 *
 * Shared by both upload paths — single-shot multipart (`core/client.ts`) and
 * chunked/resumable (`resources/_internal/chunkedUpload.ts`) — so the public
 * `UploadProgressEvent` contract (`percent` is `0..100`, rounded down; `0`
 * when `total` is unknown/`0`) stays identical across them.
 */
export function safeEmit(
  listener: UploadProgressListener | undefined,
  loaded: number,
  total: number,
): void {
  if (!listener) return;
  try {
    listener({
      loaded,
      total,
      percent: total > 0 ? Math.floor((loaded / total) * 100) : 0,
    });
  } catch {
    // Host listener errors must not abort the upload.
  }
}
