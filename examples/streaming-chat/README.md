# streaming-chat

Node CLI showing **OAuth mode** with the SDK's lazy auto-bootstrap, plus SSE
streaming: the reply is written to stdout chunk by chunk, auth-ladder events
and usage go to stderr.

Imports the SDK from `../../src/node/index` (source), so it runs against the
working tree.

## Run

Register an OAuth client first and provide its client id. The built-in
`streaming-chat-example` value is only a placeholder and will not authenticate
unless that exact client was registered in your environment.

```sh
bun install                                  # once, at the repo root
UNIFIEDAI_CLIENT_ID=<registered-client-id> bun run --cwd examples/streaming-chat start
UNIFIEDAI_CLIENT_ID=<registered-client-id> bun run --cwd examples/streaming-chat start -- "explain SSE in two sentences"
```

## What it demonstrates

- `new UnifiedAI({ appId })` — no explicit sign-in call. The **first** API
  call bootstraps auth automatically, trying in order: OS keychain cache →
  token handoff from a running UnifiedApp desktop (env/loopback, then
  discovery file) → interactive browser PKCE (opens your browser).
- `onAuthEvent` — logs each rung of that ladder (`keychain_lookup`,
  `handoff_attempt` / `handoff_result`, `browser_pkce_start`,
  `refresh_start` / `refresh_success` / `refresh_failure`, `sign_out`).
- `chat.completions.create({ ..., stream: true })` — returns the stream
  synchronously; iterate with `for await` and print
  `chunk.choices[0]?.delta?.content`.
- `stream_options: { include_usage: true }` — after the loop, `stream.usage`
  holds token counts plus `elapsed_ms` / `tokens_per_second`.
- `StreamInterruptedError` — a dropped connection mid-stream is caught and
  reported with a friendly message instead of a stack trace.

Without a cached token or a running UnifiedApp desktop, the run falls through
the ladder and opens your browser for PKCE sign-in.

## Typecheck

```sh
bunx tsc --noEmit -p examples/streaming-chat
```
