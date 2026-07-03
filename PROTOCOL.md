# Auth Protocol

Language-agnostic wire contract for `@unifiedai/sdk` and any future Rust/Go/Python ports.
Reimplement against this document and a Rust SDK should be able to read tokens
written by the TS SDK (and vice versa) without re-authenticating the user.

## Identifiers

- `client_id` — assigned per marketplace app at registration. Stable string.
- `user_id` — assigned per UnifiedAI user. Returned in token responses; SDKs never
  derive it themselves.

## Token shape

All token endpoints return and all SDKs persist the same JSON object:

```json
{
  "access_token": "string",
  "refresh_token": "string",
  "expires_at": 0,
  "user_id": "string",
  "client_id": "string"
}
```

`expires_at` is a Unix timestamp in seconds.

## Bootstrap order

An SDK MUST resolve tokens in this order on first call to `bootstrap()`:

1. **Keychain hit.** Read OS keychain entry for `(SERVICE, client_id)`. If a valid
   `TokenSet` is present, use it and stop.
2. **Env-var handoff.** If `UNIFIEDAI_HANDOFF_PORT` is set, `POST` to the desktop
   handoff endpoint on that port (see below). On `handoff_unreachable`, fall
   through. On 404 (`app_not_installed`), surface the error — do not fall back.
3. **Discovery-file handoff.** Read the discovery file (see below). If present
   and valid, `POST` to the desktop handoff endpoint on the file's port. Same
   fall-through rules as step 2.
4. **Browser PKCE.** Open the user's system browser to the authorize URL with
   a loopback `redirect_uri`. Exchange the resulting code for tokens at the
   token URL.

Persist the resulting `TokenSet` to the keychain in steps 2–4.

## Desktop handoff endpoint

The desktop runs an HTTP server on `127.0.0.1` (loopback only).

```
POST /handoff
Content-Type: application/json
Body: { "client_id": "<string>" }

200 → TokenSet JSON
404 → app_not_installed
```

Any connection failure or non-200/non-404 response → `handoff_unreachable` (SDK
falls through to the next step).

## Desktop discovery file

When the desktop starts, it writes a JSON record describing how to reach its
handoff endpoint. SDKs read this file when `UNIFIEDAI_HANDOFF_PORT` is not set.

| OS | Path |
| --- | --- |
| macOS, Linux | `~/.unifiedai/desktop.json` |
| Windows | `%APPDATA%\UnifiedAI\desktop.json` |

```json
{ "port": 0, "pid": 0, "started_at": 0 }
```

`started_at` is a Unix timestamp in seconds. The desktop SHOULD remove this
file on clean shutdown but SDKs MUST tolerate stale files (the handoff probe
will fail and the SDK will fall through).

## Browser PKCE

Standard OAuth2 authorization-code flow with PKCE (RFC 7636, S256).

Authorize URL: `https://web.unifiedai.app/oauth/authorize`

Query params:
- `client_id`
- `redirect_uri` — `http://127.0.0.1:<ephemeral>/callback`
- `response_type=code`
- `code_challenge`
- `code_challenge_method=S256`
- `state` — random per-request token; SDK rejects callbacks with mismatched
  state as `auth_state_mismatch`

Token URL: `https://api.unifiedai.app/oauth/token`

```
POST /oauth/token
Content-Type: application/json
Body: {
  "grant_type": "authorization_code",
  "code": "<from callback>",
  "code_verifier": "<original verifier>",
  "client_id": "<string>",
  "redirect_uri": "<must match authorize>"
}

200 → TokenSet JSON
```

The SDK MUST bind the loopback server before opening the browser and close it
after the callback (or on cancellation).

## Sign-out / token revocation

`signOut()` MUST attempt server-side revocation before clearing local state.

```
POST /oauth/revoke
Content-Type: application/json
Body: {
  "token": "<refresh_token>",
  "token_type_hint": "refresh_token",
  "client_id": "<string>"
}

200 → {} (always, per RFC 7009 §2.2 — even for unknown tokens)
```

Per RFC 7009 the server revokes the entire token family (the supplied token
and any rotated children). SDKs MUST treat the call as best-effort: network
failure, 4xx, or 5xx MUST NOT block clearing the local keychain entry. The
default revoke URL is derived from the token URL by replacing `/oauth/token`
with `/oauth/revoke`; it can be overridden via the `UNIFIEDAI_REVOKE_URL` env
var or an explicit `revokeUrl` option.

## Keychain storage

Tokens persist in the OS-native secret store. SDKs in any language read/write
the same entries by using these locations:

| OS | Service / target | Account |
| --- | --- | --- |
| macOS | Keychain service `com.unifiedai.sdk` | `client_id` |
| Windows | Credential Manager target `com.unifiedai.sdk/<client_id>` | `client_id` |
| Linux | Secret Service collection `default`, attributes `{ service: "com.unifiedai.sdk", account: "<client_id>" }` | — |

Stored value is the `TokenSet` JSON, UTF-8.

## Environment variables

| Name | Purpose |
| --- | --- |
| `UNIFIEDAI_HANDOFF_PORT` | Desktop handoff endpoint port. Set by the desktop when it launches an installed app. |
| `UNIFIEDAI_CLIENT_ID` | Optional fallback client_id when the SDK is not configured with one. |
| `UNIFIEDAI_TOKEN_URL` | Override the OAuth token endpoint URL (testing / staging). |
| `UNIFIEDAI_REVOKE_URL` | Override the OAuth revoke endpoint URL. Defaults to `tokenUrl` with `/oauth/token` → `/oauth/revoke`. |
| `UNIFIEDAI_AUTHORIZE_URL` | Override the OAuth authorize endpoint URL (testing / staging). |
| `UNIFIEDAI_API_URL` | Override the base URL for `/api/v1/*` and `/v1/messages` requests. Defaults to `https://api.unifiedai.app`. |

## Context compression

`POST /api/v1/chat/completions`, `POST /v1/messages`, and
`POST /api/v1/responses` accept an OPTIONAL boolean `compression` field in the
request body. Absent or `false` means off — off is the default.

```
POST /api/v1/chat/completions
Content-Type: application/json
Body: {
  "model": "<string>",
  "messages": [...],
  "compression": true
}
```

When `true`, the gateway deterministically compresses conversation context
server-side before the call reaches the provider: tool outputs and long
assistant text in older turns may be rewritten in place. User messages and the
system prompt are never modified, the last 4 messages are protected, and
messages are never added or removed. Compressed content carries
`"[compressed: <description>]"` markers, which MAY appear in context the model
sees and echoes.

SDKs SHOULD expose both a client-level default and a per-request value; the
per-request value MUST take precedence (an explicit per-request `false`
overrides a client default of `true`). When neither is set, SDKs MUST omit the
`compression` key from the wire body entirely.

Savings are observable through usage telemetry (character counts before/after
compression per call). There are no new error codes: requesting compression
never fails a call — surfaces without support simply ignore the parameter.

## Ecosystem API

The **Ecosystem API** is the server-side surface that gives standalone apps (and
external agents over MCP) the same interconnection services embedded apps get
from the desktop shell: projects, artifacts, memory, and cross-app actions. It
is a **contract, not a place** — it has two hostings that MUST expose identical
routes, shapes, and policy order:

- **Cloud hosting** — unified-api under `UNIFIEDAI_API_URL` at `/api/v1/*`,
  authenticated by any credential unified-api accepts (`uapi_` key, internal
  ES256 JWT, or OAuth access token). The caller's app identity is the resolved
  `oauth_clients.id` for OAuth callers; first-party callers have none.
- **Local hosting** — a loopback listener in the running desktop app serving the
  SAME routes from the data already on the machine (local memory ledger,
  `sdk.storage`, the project cache, artifact snapshots). See *Local ecosystem
  hosting & discovery* below. It works fully offline and is the only home of
  data the user never opted into syncing.

An SDK MUST resolve which hosting to use transparently (local first, cloud
fallback) — apps never choose a hosting explicitly. Every route below is
relative to the resolved hosting's base.

### Attribution & taint (normative)

Every write carries a **taint origin** that the **server assigns from the
resolved credential** — clients MUST NOT self-declare it, and any origin-like
field in a request body MUST be ignored. Origins:

| Caller | Taint origin |
| --- | --- |
| Shell host (internal ES256 JWT) | `host` |
| App via OAuth (`oauth_clients.id = <id>`) | `app:<id>` |
| Standalone app (OAuth, no shell attestation) | `app:<id>` (server also records a `standalone` flag) |
| External agent over MCP | `mcp-external` |

A client authenticated with an app token therefore **cannot** upload a
`host`-origin event; the server re-stamps origin on ingest. This is the wire
form of the memory-system taint rule.

### Project policy

Every project carries a server-enforced policy that gates who may contribute
memory/artifacts to it and whether external agents may read it. It is part of
the `Project` object and patchable like other project fields.

```json
{
  "autoCapture": "off | ask | on",
  "appContrib": "off | embedded-only | all",
  "mcpRead": false,
  "perApp": { "<appId>": { "memory": true, "artifacts": true } }
}
```

- `appContrib = "embedded-only"` excludes standalone (OAuth) callers; `"all"`
  admits them; `"off"` admits none.
- `mcpRead` gates whether an external agent (`mcp-external`) may read the
  project's artifacts/memory.
- `perApp` overrides the coarse toggles for a specific app id.

```
GET    /projects                       → { projects }   // list; each project.policy included
GET    /projects/:id                   → { project }    // project.policy included
PATCH  /projects/:id                   Body: { policy?, name?, metadata?, archived? }
GET    /projects/:id/members           → { members: [{ userId, role }] }   // owner or member may read
POST   /projects/:id/members           Body: { userId, role? }   // owner-only
DELETE /projects/:id/members/:userId   → { removed }              // owner-only
```

Omitting `policy` on PATCH leaves it unchanged; policy fields are merged
shallowly (a partial `policy` patches only the named keys). Member **mutations**
are owner-only; a member gets read-only access to the project's shared reads.

### Artifacts

An **Artifact** is a canonical, self-contained export of an app's work
(a design, doc, sheet) — independent of app-internal state and of whether the
producing app is currently running. It is the representation the main chat, other
apps, and external agents consume.

```json
// Artifact — the record
{
  "id": "string",
  "projectId": "string | null",
  "appId": "string",   // producing app, SERVER-attributed, never self-declared
  "kind": "string",    // open vocab, namespaced: "docs/document", "sheets/spreadsheet", "design/canvas"
  "title": "string",
  "version": 0,          // current version pointer
  "createdAt": 0,        // epoch ms
  "updatedAt": 0
}

// ArtifactVersion — an immutable snapshot
{
  "artifactId": "string",
  "version": 0,          // monotonic, server-assigned
  "content": {},         // canonical machine-readable JSON; per-kind, owned by the producing app; MUST be self-contained (no refs into app-private storage)
  "previewRef": { "bucket": "string", "path": "string", "mime": "string" }, // optional rendered preview; fetch a signed URL via GET .../preview
  "text": "string",      // REQUIRED plain-text projection for search/embedding/LLM context
  "contributedBy": "string", // client attribution, SERVER-stamped
  "createdAt": 0
}
```

- `text` is **required** on every version — it is what makes artifacts uniformly
  queryable (chat search, memory link-events, MCP context) without knowing the
  kind. An app that cannot render text forgoes searchability.
- Versions are **whole snapshots** (no deltas). The append-only version list is
  what lets chat reference an artifact "as of" a prior version.
- `content` schema is owned by the producing app and published via its manifest
  `kinds` field so consumers (including external agents) can interpret it;
  `previewRef` + `text` keep an artifact useful to consumers that cannot.

```
GET  /artifacts?projectId=&kind=          → { artifacts: Artifact[] }   // projectId REQUIRED in v1 (local hosting); kind filter is Phase 2
POST /artifacts                            Body: { projectId?, kind, title, content, text, previewB64?, previewMime? }
                                           → { artifact, version }         // creates the artifact + version 1
GET  /artifacts/:id                        → { artifact, latest }          // latest = newest ArtifactVersion
POST /artifacts/:id/versions               Body: { content, text, previewB64?, previewMime? }
                                           → { artifact, version }         // appends a version, bumps the pointer
GET  /artifacts/:id/versions/:v            → { version }                   // content + text (preview via signed URL)
GET  /artifacts/:id/preview?v=             → { url, mime }                 // signed URL to the version's preview (defaults to latest)
```

A chat reference is `artifact://<id>@<version>`, resolved through these routes.

### Memory

The memory ledger is **append-only events**. A write is a batch append; the
server stamps `id`, `createdAt`, and (per the taint rule above) `taintOrigin`.
Writes from untrusted callers (`app:*`, `mcp-external`) are **proposals**,
surfaced for confirmation in the owning app; first-party (`host`) writes apply
directly.

```json
// MemoryEvent — on read
{
  "id": "string",
  "projectId": "string | null",
  "type": "string",       // append vocabulary: "observation" | "summary" | "tombstone" | ...
  "content": {},          // event payload (ledger-defined)
  "taintOrigin": "string",// SERVER-stamped (host | app:<id> | mcp-external)
  "provenance": {},       // source refs
  "salience": {},         // optional salience inputs
  "status": "applied | proposed",
  "seq": 0,                // monotonic append cursor (the value echoed back as `cursor`)
  "createdAt": 0
}
```

```
POST /memory/events                 Body: { projectId?, events: [{ type, content, provenance?, salience? }] }
                                    → { events: MemoryEvent[] }   // each with server-stamped id/origin/status
GET  /memory/events?since=&projectId=  → { events: MemoryEvent[], cursor }   // append-only sync; `since` is the opaque `seq` cursor
POST /memory/query                  Body: { projectId?, query, k, hybrid? }
                                    → { results }
```

`hybrid: true` requests RRF-fused lexical+vector ranking (the `mcp-external` read
path); omitted/false is lexical-only. Ranking is still caller-class gated server-side —
the flag can only *request* hybrid, never widen what the caller may read.

`results` shape is hosting-dependent: the **cloud** hosting returns `[{ event, score }]`
(RRF-fused for `mcp-external`); the **local** hosting returns the grant-gated,
per-caller-redacted memory items directly (no score — it uses the full client-side
scorer for ordering). Callers MUST treat an item's presence, not a numeric score, as
the contract.

- A **tombstone** is itself an append (`type: "tombstone"`, `content` naming the
  target event id) — deletions never mutate history.
- `POST /memory/query` ranking is caller-class gated: lexical (`tsvector`) for
  shell/standalone callers; RRF-fused lexical+vector for the `mcp-external` read
  path (vector rows populated lazily, so a not-yet-embedded row contributes only
  its lexical score). The local hosting serves this query with the full
  client-side retrieval scorer (MMR/salience/epoch).

### Action registry

Standalone apps participate in cross-app actions by **declaring** the same
`ActionSpec` embedded apps use, then serving invocations over a **pull** channel
(so a CLI behind NAT needs no reachable HTTPS endpoint). An optional push webhook
is available for apps that can host one.

```
# Developer app identity (the platform-first root; appId is developer-chosen + unique)
POST /registry/apps                 Body: { appId, display?, declaredScopes?, oauthClientId? }  → RegisteredApp
GET  /registry/apps                 → { apps: RegisteredApp[] }     // the caller's own registered apps
GET  /registry/whoami               → { appId, scopes }             // resolve the caller's app identity (class-4 enroll)

# Action declaration + discovery
POST /registry/actions              Body: { actions: ActionSpec[] }   // appId is SERVER-derived from the credential
GET  /registry/actions?appId=       → { actions: RegisteredAction[] } // each with a `live` flag; discovery for the chat agent loop

# Pull-based invocation transport
POST /registry/invocations              Body: { appId, actionId, args }  → { id } | { status: "offline" }   // invoker enqueues
GET  /registry/invocations/pending      → { invocations: [{ id, actionId, args }] }   // the app pulls (and clears) its work; marks it live
POST /registry/invocations/:id/respond  Body: { result } | { error }   // only the TARGET app may respond
GET  /registry/invocations/:id          → { status: "pending" } | { status: "done", result?, error? }   // invoker polls the result
POST /registry/webhook                  Body: { url }   // optional: push invocations here instead of pull (https + public host)
```

- Wire action names remain `<appId>__<actionId>` — identical to the in-shell
  path, so the (embedded)/(standalone) surfaces cannot drift. `ActionSpec` is the
  exact shape from the shell (`src/apps/types.ts`); it is not redefined here.
- **Liveness is explicit:** an app is *live* if it pulled its inbox recently or
  registered a webhook. The chat agent loop treats actions of a non-live app as
  unavailable and falls back to that app's artifacts.
- A registered webhook makes delivery **push-only** (not also enqueued), so an app
  that both handles the push and polls can't execute one invocation twice.

### Local ecosystem hosting & discovery

When the desktop app starts it writes a discovery record next to the auth
discovery file so local clients can reach the loopback ecosystem hosting.

| OS | Path |
| --- | --- |
| macOS, Linux | `~/.unifiedai/ecosystem.json` |
| Windows | `%APPDATA%\UnifiedAI\ecosystem.json` |

```json
{ "url": "http://127.0.0.1:0", "token": "string", "pid": 0, "started_at": 0 }
```

- `url` is the loopback base (ephemeral port). `token` is a per-launch,
  per-app-mintable local token the caller sends as `Authorization: Bearer
  <token>` (or `X-Ecosystem-Token`). The desktop SHOULD remove the file on clean
  shutdown; clients MUST tolerate a stale file (the probe fails and they fall
  through).
- **Resolution order (SDK):** on first ecosystem call, an SDK MUST (0) if the shell
  injected `UNIFIEDAI_ECOSYSTEM_URL` + `UNIFIEDAI_ECOSYSTEM_TOKEN` (a bundled/class-3
  child launched by the desktop), use them directly — no probe (the shell set them for
  this exact process); (1) else read `ecosystem.json` and probe `GET <url>/health` with
  a short fail-fast deadline (~500 ms) — if it answers, use the local hosting; a
  standalone (class-4) app holding an OAuth token MAY then upgrade the powerless anonymous
  discovery token to a scoped one via `POST <url>/enroll` (`Authorization: Bearer
  <oauth>` → `{ token }`), falling back to the anonymous token when enroll fails;
  (2) otherwise use the cloud hosting (`UNIFIEDAI_API_URL`) with the normal bearer
  credential. This mirrors the keychain → handoff → PKCE bootstrap order: local presence
  is preferred, and its absence degrades to cloud (or, offline, to a
  `handoff_unreachable`-style local-only failure) rather than erroring.

The local hosting runs the SAME policy sequence as the cloud hosting
(authenticate → scope → grant/policy → execute → audit); it is the shell's
broker logic re-fronted as HTTP, not a second policy implementation.

## Error codes

SDKs surface these as typed errors. Names normative; messages free-form.

- `not_bootstrapped` — `identity()` called before `bootstrap()`, or `client_id`
  not resolvable.
- `app_not_installed` — desktop 404'd the `client_id`.
- `handoff_unreachable` — desktop handoff probe failed (used internally for
  fall-through; only surfaced if there is no fallback path).
- `auth_user_cancelled` — browser OAuth flow returned `error=access_denied` or
  equivalent.
- `auth_state_mismatch` — loopback callback's `state` did not match.
- `auth_token_exchange_failed` — token endpoint rejected or returned malformed
  body.
- `keychain_unavailable` — OS keychain inaccessible (no native module, locked,
  etc.). SDKs MAY treat persist failures as non-fatal for the current session.
- `model_deprecated` — a call-time request named a model that has been retired.
  unified-api returns HTTP `410` with body `{code: "model_deprecated", message}`
  from any model endpoint (chat, messages, embeddings, images, responses, …);
  the model is also absent from `models.list()`. SDKs MUST key off the body
  `code`, not the `410` status alone — `410` is also returned for expired upload
  sessions. Retrying does not help; switch to a current model.

Ecosystem API (returned by both hostings; HTTP status in parentheses):

- `ecosystem_unreachable` — the local ecosystem hosting probe failed and no cloud
  fallback is configured or reachable (internal fall-through analogue of
  `handoff_unreachable`; only surfaced when offline with no cloud base).
- `scope_denied` (403) — the credential's OAuth scopes do not admit the route
  (checked before grants).
- `policy_denied` (403) — scopes admit the route but the per-project policy or a
  per-app grant does not (e.g. `appContrib` excludes a standalone caller, or
  `mcpRead` is false for an `mcp-external` reader).
- `artifact_not_found` (404) — no artifact/version for the id (`artifact://`
  resolution failures use this).
- `app_not_registered` (403) — an `actions:register`/OAuth caller whose
  `oauth_clients.id` has no linked `registered_apps` row, so app identity cannot
  be attributed.
- `route_not_found` (404) — no ecosystem route matches the method+path (distinct
  from `artifact_not_found`, which means the route matched but the resource is
  absent).
- `bad_request` (400) — a required parameter is missing or malformed (e.g. a
  `list_artifacts` with no `projectId`, or a `search_memory` with no `query`).
- `timeout` (504) — the local hosting forwarded the request to the webview but no
  reply arrived within the per-request deadline.
- `internal` (500) — an unclassified handler error; the message is diagnostic
  only and MUST NOT be branched on.
