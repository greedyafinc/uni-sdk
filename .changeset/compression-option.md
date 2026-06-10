---
"@unifiedai/sdk": minor
---

Add `compression` option (client-level default + per-request param on
chat/messages/responses) for UNI-100 gateway auto compression.

- `compression?: boolean` on the client constructor sets the default for every
  `chat.completions.create`, `messages.create`, and `responses.create` call.
- The same field on the per-request params overrides the client default — an
  explicit `false` beats a client default of `true`.
- When neither is set, the key is omitted from the wire body entirely
  (default off; the gateway behaves exactly as before).

When `true`, the gateway deterministically compresses older conversation
context (tool outputs, long prior assistant turns) server-side before routing.
See PROTOCOL.md "Context compression" for the wire contract.
