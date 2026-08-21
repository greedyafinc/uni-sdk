# browser-trusted-token

Minimal browser page (no framework) showing the **trusted-token** mode of
`@unifiedai/sdk`: the host supplies the access token, the SDK never runs an
auth flow. Demonstrates constructing `UnifiedAI` from the browser entry,
subscribing to `session.onChange`, and a non-streaming chat call.

Imports the SDK from `../../src/index` (source), so it runs against the
working tree.

## Run

```sh
bun install                                        # once, at the repo root
bun run --cwd examples/browser-trusted-token start # serves index.html via Bun's dev server
```

Then open the printed URL, paste an access token, hit **Connect**, and send a
prompt.

## Where does the token come from?

In a real integration the **host** supplies it. When an app runs inside
UnifiedApp, the desktop broker mints a short-lived, app-scoped access token and
hands it to the embedded page — the app never sees the user's long-lived
credentials. The host passes that value as the `token` option (either a plain
string, or a callback `() => string | Promise<string>` that returns a fresh
token per request; on a 401 the SDK re-invokes it once and retries).

For manual testing, paste a valid access token from your own development
environment. The page keeps it in memory only. The streaming-chat example runs
OAuth internally but deliberately does not print or expose its tokens.

## Typecheck

```sh
bunx tsc --noEmit -p examples/browser-trusted-token
```
