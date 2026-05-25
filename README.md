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
