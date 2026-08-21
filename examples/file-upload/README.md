# file-upload

Node script exercising the `sdk.files` resource: upload a file with a
byte-level progress listener, list your files, fetch the content back, and
delete it.

Imports the SDK from `../../src/node/index` (source), so it runs against the
working tree. Uses OAuth mode with lazy auto-bootstrap — the first call signs
in automatically (keychain → UnifiedApp handoff → browser PKCE).

## Run

Register an OAuth client first and provide its client id. The built-in
`file-upload-example` value is only a placeholder and will not authenticate
unless that exact client was registered in your environment.

```sh
bun install                               # once, at the repo root
UNIFIEDAI_CLIENT_ID=<registered-client-id> bun run --cwd examples/file-upload start
```

## API surface exercised

- `files.create(source, options)` — `source` is `Blob | File | Buffer |
  ArrayBuffer | Uint8Array | base64 data-URL string`; options include `filename`,
  `contentType` (sniffed from magic bytes if omitted), `purpose`, and
  `onProgress: ({ loaded, total, percent }) => void`. Files over 5 MB
  automatically switch to the resumable chunked-upload protocol (tunable via
  `chunkedUploadThreshold`). This example's small generated text file exercises
  progress but not the chunked path; pass a payload over 5 MB to exercise it.
- For restart-safe chunking, persist the id from `onPersistUploadId` and pass
  it back as `resumeFrom`. The persistence hook receives `null` after success
  or caller abort.
- `files.list()` — `{ data: FileObject[] }`, newest first.
- `files.content(id)` — `{ bytes: ArrayBuffer, contentType, filename? }`.
- `files.del(id)` — `{ id, deleted }`.

(`files.upload()` is the separate image-only variant that returns a signed
`image_url` for use with `images.edit`; `files.create()` is the general one —
its returned `id` works as a `file_id` in multimodal content parts across
chat/responses/messages.)

## Typecheck

```sh
bunx tsc --noEmit -p examples/file-upload
```
