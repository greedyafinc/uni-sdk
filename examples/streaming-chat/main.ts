// Streaming chat CLI — OAuth mode.
//
// `new UnifiedAI({ appId })` arms lazy auto-bootstrap: no explicit signIn()
// call is needed. The FIRST API call walks the auth ladder automatically —
// OS keychain → handoff from a running UnifiedApp desktop (env/loopback or
// discovery file) → interactive browser PKCE. `onAuthEvent` lets you watch
// each rung as it happens.
import { UnifiedAI, StreamInterruptedError } from "../../src/node/index";

const sdk = new UnifiedAI({
  appId: process.env.UNIFIEDAI_CLIENT_ID ?? "streaming-chat-example",
  onAuthEvent: (event) => {
    const { type, ...detail } = event;
    const extra = Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : "";
    console.error(`[auth] ${type}${extra}`); // stderr, so stdout stays clean for the reply
  },
});

const prompt = process.argv.slice(2).join(" ") || "Write a haiku about streaming APIs.";
console.error(`[prompt] ${prompt}\n`);

// With `stream: true` this returns a ChatCompletionStream synchronously (not a
// Promise) — auth bootstrap and the request itself happen during iteration.
const stream = sdk.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: prompt }],
  stream: true,
  stream_options: { include_usage: true }, // ask for a terminal usage chunk
});

try {
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) process.stdout.write(delta);
  }
  process.stdout.write("\n");

  // Populated from the terminal usage chunk once the stream completes.
  const usage = stream.usage;
  if (usage) {
    console.error(
      `\n[usage] input=${usage.input_tokens} output=${usage.output_tokens} ` +
        `total=${usage.total_tokens} elapsed=${usage.elapsed_ms}ms ` +
        `(${usage.tokens_per_second.toFixed(1)} tok/s)`,
    );
  }
} catch (err) {
  if (err instanceof StreamInterruptedError) {
    console.error("\nConnection dropped mid-response — the reply above is incomplete. Please retry.");
    process.exit(1);
  }
  throw err;
}
