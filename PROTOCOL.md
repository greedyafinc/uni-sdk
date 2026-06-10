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
