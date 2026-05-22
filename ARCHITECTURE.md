# Architecture

How the source is organised, and where new code goes.

## Layout

```
src/
├── index.ts        # public barrel — only what's exported here is part of the SDK's API
├── client.ts       # UnifiedAI class + bootstrap()/identity() (entry point: `new UnifiedAI({ ... })`)
├── core.ts         # transport — fetch wrapper, auth headers, error mapping
├── errors.ts       # UnifiedError class + UnifiedErrorCode
├── identity.ts     # Identity public type
├── _internal/      # private modules: env, discovery, handoff, pkce, browser-auth, loopback, keychain, open-url, tokens
└── resources/      # one file per resource (LLM, context, events, registry, …)

tests/              # bun test files, mirroring src/
.changeset/         # changesets config + pending version bumps
.github/workflows/  # CI, release, docs
```

## Conventions

- **One resource per file** in `src/resources/`. Each file exports the
  resource class (e.g. `Messages`, `Embeddings`) **and** its public types
  (request/response shapes). Don't put types in a separate directory —
  colocate them with the resource that owns them.
- **Cross-cutting types** that span multiple resources (e.g. a shared event
  union) can live at the top of `src/` as their own file (e.g.
  `src/events.ts`), not in a `types/` dump.
- **Public helpers** (e.g. `createEvent`, `appLink`) live at the top of
  `src/` as individual files, not inside a `utils/` directory.
- **Internal-only helpers** colocate with their caller. If you need to share
  one across resources, lift it to `src/_internal/` (underscore prefix marks
  it as private — never re-exported from `index.ts` except as `type` re-exports
  for adapter injection).
- **Native runtime.** Marketplace apps ship as `.app`/`.exe`/CLI binaries, so
  the SDK runs in a real process and can use `node:*` APIs. Stick to standard
  `node:*` modules so the SDK works under both Bun and Node.

## Adding a resource

1. Create `src/resources/<name>.ts`:

   ```ts
   import { Core } from "../core";

   export interface MyResourceCreateParams {
     // ...
   }

   export interface MyResource {
     // ...
   }

   export class MyResources {
     constructor(private readonly client: Core) {}

     async create(params: MyResourceCreateParams): Promise<MyResource> {
       return this.client.request("/v1/my-resource", {
         method: "POST",
         body: params,
       });
     }
   }
   ```

2. Attach it to `UnifiedAI` in `src/client.ts`:

   ```ts
   import { MyResources } from "./resources/my-resource";

   export class UnifiedAI extends Core {
     readonly myResources = new MyResources(this);
   }
   ```

3. Re-export the public types from `src/index.ts`:

   ```ts
   export type { MyResource, MyResourceCreateParams } from "./resources/my-resource";
   ```

4. Add a test in `tests/resources/my-resource.test.ts`.

5. Record the change with `bun run changeset`.

## Auth & bootstrap

`UnifiedAI.bootstrap()` is idempotent and resolves the user identity before
any authenticated call. The flow is keychain → env-var handoff → discovery-file
handoff → browser PKCE. Tokens live in a module-private `WeakMap` keyed by the
`UnifiedAI` instance — there is no public accessor; only `sdk.identity()` is
exposed, returning `{ user_id, client_id }`.

The wire protocol (endpoints, discovery file, keychain locations, env vars,
PKCE params) is documented in [PROTOCOL.md](PROTOCOL.md) so future Rust/Go/Python
SDKs can interop with the same keychain entries and desktop endpoint.

Defaults can be overridden via `UnifiedAIOptions` (`keychain`, `env`, `discovery`,
`openUrl`, `loopback`, `authorizeUrl`, `tokenUrl`). Production code should rarely
touch them; tests and the demo harness use the seams to inject fakes.

## Errors

All thrown errors must be `UnifiedError` instances. Map HTTP / transport
failures inside `Core.request`; resources should not catch and re-wrap.

## Public surface = `src/index.ts`

If a name isn't exported from `src/index.ts`, it isn't part of the SDK and
can be renamed/removed without a major bump. Treat `index.ts` as the
contract.
