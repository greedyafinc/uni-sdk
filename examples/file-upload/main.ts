// File upload example — upload, watch progress, list, round-trip content.
//
// OAuth mode with lazy auto-bootstrap: the first files call signs in
// automatically (keychain → UnifiedApp handoff → browser PKCE).
import { UnifiedAI } from "../../src/node/index";

const sdk = new UnifiedAI({
  appId: process.env.UNIFIEDAI_CLIENT_ID ?? "file-upload-example",
  onAuthEvent: (event) => console.error(`[auth] ${event.type}`),
});

// files.create accepts Blob | ArrayBuffer | Uint8Array | base64 data-URL
// string. To upload from disk, read the file first, e.g.:
//   const bytes = await readFile("./photo.png");   // node:fs/promises
const body = new TextEncoder().encode(
  `Hello from the uni-sdk file-upload example.\nUploaded at ${new Date().toISOString()}\n`,
);

// 1. Upload. `onProgress` fires with { loaded, total, percent } — once at 0,
//    then per chunk, ending at loaded === total.
const file = await sdk.files.create(body, {
  filename: "uni-sdk-example.txt",
  contentType: "text/plain",
  onProgress: ({ loaded, total, percent }) => {
    console.log(`  upload: ${percent}% (${loaded}/${total} bytes)`);
  },
});
console.log(
  `created: id=${file.id} filename=${file.filename} bytes=${file.bytes} purpose=${file.purpose}`,
);

// 2. List files (newest first).
const { data } = await sdk.files.list();
console.log(`\nyour files (${data.length}):`);
for (const f of data.slice(0, 10)) {
  console.log(`  ${f.id}  ${f.filename}  ${f.bytes}B  ${f.created_at}`);
}

// 3. Fetch the content back.
const content = await sdk.files.content(file.id);
console.log(`\nround-trip (${content.contentType}, ${content.bytes.byteLength} bytes):`);
console.log(new TextDecoder().decode(content.bytes));

// 4. Clean up so repeated runs don't accumulate files.
const deleted = await sdk.files.del(file.id);
console.log(`deleted ${deleted.id}: ${deleted.deleted}`);
