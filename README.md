# @unifiedai/sdk

Official SDK for Unifiedai marketplace apps. Ships two entry points so the
same package works in the browser, in Workers/edge, and in Node CLIs — without
forcing any consumer to bundle Node-only modules.

## Install

```sh
bun add @unifiedai/sdk
```

## Which entry should I import?

```ts
// Browser, Tauri WebViews, Workers, edge runtimes, server-side trusted hosts
import { UnifiedAI } from "@unifiedai/sdk";

// Node CLIs and desktop apps that run OAuth via local loopback + OS keychain
import { UnifiedAI } from "@unifiedai/sdk/node";
```

The default entry is **browser-safe**: it never resolves `node:*` specifiers
or `@napi-rs/keyring`, and Vite/Webpack/Rollup/esbuild will bundle it without
polyfills. It requires you to supply a bearer token via the `token` option.

The `/node` entry is a **strict superset**: same resources, plus the
Authorization Code + PKCE OAuth flow with a local loopback HTTP listener,
discovery file lookups, and OS keychain storage. Same class name (`UnifiedAI`)
in both — call sites read identically.

## Usage

### Trusted-token mode (browser, edge, server)

```ts
import { UnifiedAI } from "@unifiedai/sdk";

const sdk = new UnifiedAI({
  apiUrl: "https://api.unifiedai.app",
  // Static string, or async function called on every request.
  token: async () => readBearerFromSession(),
});

const usage = await sdk.usage.get();
const stream = sdk.responses.create({
  model: "gpt-4",
  input: [{ role: "user", content: "Hello" }],
  stream: true,
});
for await (const event of stream) {
  if (event.type === "response.output_text.delta") process.stdout.write(event.delta);
}
```

The SDK calls your `token` provider on every request. On 401 it calls it once
more (single-flighted across concurrent requests) so your host can rotate the
token; if the retry still 401s, the SDK throws `UnifiedAIAuthError`.

#### Embeddings

```ts
const res = await sdk.embeddings.create({
  model: "togethercomputer/m2-bert-80M-8k-retrieval",
  input: ["the quick brown fox", "jumps over the lazy dog"],
});
for (const item of res.data) {
  console.log(item.index, item.embedding.length);
}
```

`input` accepts a single string or an array of strings (OpenAI parity). The
response mirrors the OpenAI Embeddings shape:
`{ object, data: [{ object, embedding, index }], model, usage }`.

#### Files (upload + reference by `file_id`)

```ts
// 1. User picks a file (browser File picker, drag-drop, fs.readFile, …).
const file: File = pickedByUser;

// 2. Upload it. Returns a stable `file_id` plus a short-lived signed URL.
const { file_id, image_url } = await sdk.files.upload(file);

// 3. Reference the uploaded image by URL in any chat / responses / images call.
//    The signed URL is publicly reachable and expires in ~1 hour, which is
//    long enough for typical request chains; for longer-lived references,
//    keep the bytes locally or re-upload.
const res = await sdk.responses.create({
  model: "gpt-4o",
  input: [
    {
      role: "user",
      content: [
        { type: "input_text", text: "What's in this image?" },
        { type: "input_image", image_url },
      ],
    },
  ],
});

await sdk.images.edit({
  model: "gpt-image-1",
  images: [{ image_url }],
  prompt: "make it sepia",
});
```

`sdk.files.upload(source, { filename?, contentType?, signal? })` accepts a
`Blob`, `File`, `Buffer`, `Uint8Array`, `ArrayBuffer`, or a base64 `data:` URL.
Filename and content-type are auto-detected from `File`/`Blob` metadata when
present and can be overridden via the options object. The upload endpoint is
image-only today (PNG/JPEG/WEBP up to 25 MB).

> **Why `image_url` and not `file_id`?** The SDK's typed surfaces (`images.edit`,
> `responses.create`, `chat.completions.create`) all accept a `file_id` field,
> and `sdk.files.upload()` returns one — but the backend currently forwards
> the id to upstream providers verbatim instead of resolving it to a signed
> URL first, so providers reject it with "Failed to decode image data". Use
> `image_url` from the upload response everywhere downstream until that
> backend resolution layer ships (tracked as a backend-side issue).

#### Messages (Anthropic) streaming

```ts
const stream = sdk.messages.create({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Stream a haiku." }],
  stream: true,
});

// Walk events as they arrive…
for await (const event of stream) {
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    process.stdout.write(event.delta.text);
  }
}

// …or skip the events and just await the assembled message:
const message = await sdk.messages
  .create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Stream a haiku." }],
    stream: true,
  })
  .finalMessage();
console.log(message.stop_reason, message.usage);
```

Call `stream.abort()` to cancel mid-flight; it closes the underlying fetch and
ends the iterator. `stream.usage` is populated once `message_delta` lands.

### OAuth mode (Node CLI, desktop)

```ts
import { UnifiedAI } from "@unifiedai/sdk/node";

const sdk = new UnifiedAI({ appId: "your-client-id" });
await sdk.bootstrap(); // → opens browser, runs PKCE, stores in OS keychain
const me = sdk.identity();
```

Bootstrap tries cached keychain tokens → environment-supplied handoff port →
discovery-file handoff → fresh browser PKCE. Refresh tokens are rotated
transparently on 401.

## Error handling

The SDK throws typed errors from `@unifiedai/sdk` so consumers can branch on
the failure mode without parsing strings. All HTTP errors subclass
`UnifiedAIError`, which in turn subclasses `Error` — `instanceof Error` keeps
working for catch-all handlers.

| Class                  | HTTP   | Extra fields                                |
| ---------------------- | ------ | ------------------------------------------- |
| `BadRequestError`      | 400    | —                                           |
| `AuthenticationError`  | 401    | —                                           |
| `NotFoundError`        | 404    | —                                           |
| `RateLimitError`       | 429    | `retryAfter` (seconds)                      |
| `UsageLimitError`      | 429    | `periodCost`, `limit`, `resetAt`, `isUsageLimit` |
| `ServerError`          | 5xx    | —                                           |
| `UnifiedAIError`       | other  | base — has `code`, `status`, `body`, `headers`, `requestId` |
| `UnifiedAIAuthError`   | 401    | refresh-token failures; extends `AuthenticationError` |

`RateLimitError` covers transient throttling (e.g. too many requests in a
short window — wait and retry). `UsageLimitError` signals plan-quota
exhaustion for the billing period; retrying won't help. They are
**siblings**, not parent/child — `UsageLimitError` does *not* pass an
`instanceof RateLimitError` check, so a generic retry wrapper must catch
both explicitly. Always check the more specific class first.

```ts
import {
  UnifiedAI,
  AuthenticationError,
  RateLimitError,
  UsageLimitError,
  BadRequestError,
  ServerError,
  UnifiedAIError,
} from "@unifiedai/sdk";

const sdk = new UnifiedAI({ token: process.env.UNIFIEDAI_TOKEN });

try {
  await sdk.chat.completions.create({ model: "gpt-4o-mini", messages: [...] });
} catch (err) {
  if (err instanceof UsageLimitError) {
    console.error(`Quota exhausted: $${err.periodCost} / $${err.limit}`);
  } else if (err instanceof RateLimitError) {
    console.error(`Throttled — retry in ${err.retryAfter ?? "?"}s`);
  } else if (err instanceof AuthenticationError) {
    console.error("API key invalid or revoked");
  } else if (err instanceof BadRequestError) {
    console.error("Request rejected:", err.body);
  } else if (err instanceof ServerError) {
    console.error("Upstream failure:", err.requestId);
  } else if (err instanceof UnifiedAIError) {
    console.error(`Unexpected ${err.status}:`, err.message);
  } else {
    throw err;
  }
}
```

## Project layout

```
src/
├── index.ts                  # browser entry
├── core/                     # shared base (UnifiedAI, Core, errors, stream/sse)
├── resources/                # chat, messages, models, responses, usage, logos
└── node/                     # OAuth extension (PKCE, keychain, loopback, handoff)
```

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the dep graph and conventions.

## Development

```sh
bun install
bun run lint        # biome
bun run typecheck   # tsc --noEmit
bun test            # bun test (core + node + bundle integrity)
bun run build       # browser bundle + node bundle + types + verify
bun run docs        # typedoc → ./docs
```

The build runs a structural-invariant check (`scripts/verify-browser-bundle.ts`)
that fails if the browser bundle ever picks up a `node:*` specifier or
`@napi-rs/keyring`.

## Releasing

Releases are driven by [Changesets](https://github.com/changesets/changesets).
A PR with a `.changeset/*.md` file lands on `main`; the release workflow opens
a "Version Packages" PR; merging that PR publishes to npm.

Requires the `NPM_TOKEN` repo secret.

## License

MIT
