# Architecture

How the source is organised, and where new code goes.

## Two-entry layout

The SDK ships two entry points so the same package works in browsers, Workers,
edge runtimes, and Node — without forcing any consumer to bundle Node-only
modules.

```
@unifiedai/sdk         → browser-safe (default; zero `node:*` deps)
@unifiedai/sdk/node    → strict superset; adds OAuth/PKCE/keychain/loopback
```

Bundlers auto-resolve via the `browser` / `node` export conditions in
`package.json`. Same class name (`UnifiedAI`) in both entries — call sites
read identically regardless of which target you build for.

## Source layout

```
src/
├── index.ts                  # browser entry — exports the browser-safe surface
├── core/                     # shared base, both entries depend on this
│   ├── client.ts             # UnifiedAI base class (trusted-token mode)
│   ├── core.ts               # transport types (Core, RequestOptions, TokenProvider)
│   ├── errors.ts             # UnifiedError + subclasses
│   ├── identity.ts           # Identity public type
│   └── _internal/
│       ├── sse.ts            # SSE frame parser
│       ├── stream.ts         # UnifiedStream async-iterable
│       ├── tokens.ts         # TokenSet type
│       └── http-errors.ts    # error-body extraction helpers
├── resources/                # one file per resource; browser-safe
│   ├── chat.ts
│   ├── messages.ts
│   ├── models.ts
│   ├── responses.ts
│   ├── usage.ts
│   ├── logos.ts
│   └── logos.generated.ts
└── node/                     # OAuth/CLI extension; pulls Node-only deps
    ├── index.ts              # node entry — re-exports browser surface + adds OAuth UnifiedAI
    ├── client.ts             # UnifiedAI subclass: bootstrap, signOut, identity, refresh
    └── _internal/
        ├── browser-auth.ts   # runBrowserPkce (CLI-style)
        ├── discovery.ts      # ~/.config/unifiedai/desktop.json
        ├── env.ts            # UNIFIEDAI_* env reader
        ├── handoff.ts        # tries the desktop handoff endpoint
        ├── keychain.ts       # @napi-rs/keyring (lazy)
        ├── loopback.ts       # node:http for OAuth redirect callback
        ├── open-url.ts       # node:child_process to open browser
        ├── pkce.ts           # crypto-based code challenge/verifier
        ├── refresh.ts        # refresh-token grant
        ├── revoke.ts         # token revocation
        └── token-endpoint.ts # postTokenGrant helper

tests/
├── core/                     # browser-safe behavior; imports from src/index.ts
├── node/                     # OAuth behavior; imports from src/node/index.ts
└── bundle/                   # asserts dist/index.browser.js is node-free

scripts/
└── verify-browser-bundle.ts  # bundle-content gate; runs on every build
```

## Class hierarchy

```
Core (core/core.ts)
   ↑
UnifiedAI (core/client.ts)        ← browser entry
   ↑                                exports this as `UnifiedAI`
UnifiedAI (node/client.ts)        ← node entry
                                    re-exports as `UnifiedAI` (subclass)
```

`request()` and `stream()` live on the base. They go through three protected
hooks that the subclass overrides:

- `getInitialAccessToken()` — base returns from the trusted-token provider;
  subclass returns from the OAuth tokens it owns
- `refreshAccessToken()` — base re-invokes the provider with single-flight
  coalescing; subclass runs the refresh-token grant
- `onAuthFailure()` — base no-op; subclass clears local session + keychain

All four code paths (browser+trusted, node+trusted, node+OAuth, future
node+OAuth-with-token) share one 401-retry implementation.

## Conventions

- **One resource per file** in `src/resources/`. Each file exports the
  resource class **and** its public types — colocate them, don't put types
  in a separate dump directory.
- **Cross-cutting universal types** live at the top of `src/core/` as their
  own file.
- **Internal-only helpers** colocate with their caller. If you need to share
  one, lift it to the nearest `_internal/` (underscore marks it private —
  never re-exported from any `index.ts`).
- **New file: where does it go?**
  - Static `node:*` import? → `src/node/_internal/`
  - Uses `fetch`/`ReadableStream`/`crypto.subtle`/runtime-agnostic only?
    → `src/core/_internal/` if shared, else colocate with caller
- **`tsconfig` lint rule** (eslint `no-restricted-paths`, planned) forbids
  imports from `src/node/` inside `src/core/` or `src/resources/` so the
  boundary can't silently regress.

## Adding a resource

1. Create `src/resources/<name>.ts`:

   ```ts
   import { Core } from "../core/core";

   export interface MyResource { /* ... */ }
   export interface MyResourceCreateParams { /* ... */ }

   export class MyResources {
     constructor(private readonly client: Core) {}
     async create(params: MyResourceCreateParams): Promise<MyResource> {
       return this.client.request("/v1/my-resource", { method: "POST", body: params });
     }
   }
   ```

2. Attach it to the base `UnifiedAI` in `src/core/client.ts`. The node
   subclass inherits it automatically:

   ```ts
   readonly myResources: MyResources = new MyResources(this);
   ```

3. Re-export public types from BOTH `src/index.ts` and `src/node/index.ts`
   (or via the `export * from "../resources/<name>"` line that already
   bridges them).

4. Add a test in `tests/core/<name>.test.ts` using a fake fetch.

5. Record the change with `bun run changeset`.

## Auth & bootstrap

`UnifiedAI.bootstrap()` is idempotent. In trusted-token mode it's a no-op.
In OAuth mode (node entry only) it resolves the user identity via:

1. cached keychain tokens for the client_id
2. env-var-supplied handoff port (`UNIFIEDAI_HANDOFF_PORT`)
3. discovery-file handoff (`~/.config/unifiedai/desktop.json`)
4. fresh browser PKCE (loopback receives the redirect)

Tokens are private instance state on the subclass. Refresh runs single-flighted
on 401 with transparent retry. `sdk.identity()` returns `{ user_id, client_id }`.

The wire protocol (endpoints, discovery file format, keychain entry name,
env vars, PKCE params) is documented in [PROTOCOL.md](PROTOCOL.md) so future
Rust/Go/Python SDKs can interop with the same keychain entries and
desktop endpoint.

## Errors

All thrown errors must be `UnifiedError` or one of its subclasses
(`UnifiedAIError` for HTTP failures, `UnifiedAIAuthError` for auth failures).
Map HTTP / transport failures inside the base `request()`/`stream()`; resources
should not catch and re-wrap.

`UnifiedAIError.message` includes a server-extracted snippet when the body
matches a known shape (`{message}`, `{error}`, `{error: {message}}`, FastAPI
`{detail}`, `{errors[]}`). The full body is on `err.body`.

## Public surface = the two `index.ts` files

If a name isn't exported from `src/index.ts` (browser surface) or
`src/node/index.ts` (node surface), it isn't part of the SDK and can be
renamed/removed without a major bump. Treat both as the contract.

The bundle-content test (`tests/bundle/browser-bundle.test.ts`) plus the
`scripts/verify-browser-bundle.ts` step enforce the **structural invariant**
that the browser bundle contains no `node:*` specifier and no
`@napi-rs/keyring` reference.
