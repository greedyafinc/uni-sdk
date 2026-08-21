// Browser trusted-token example.
//
// In trusted-token mode the HOST application supplies the access token — the
// SDK never runs an auth flow of its own. A real host (e.g. UnifiedApp) mints
// a short-lived app-scoped token via its broker and hands it to the embedded
// app; the app passes it as `token` (a string, or a sync/async callback that
// returns a fresh token per request). Here you paste one manually.
import { UnifiedAI } from "../../src/index";

// Point at a local gateway during development if you have one running.
const API_URL = "https://api.unifiedai.app";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const tokenInput = $<HTMLInputElement>("token");
const connectBtn = $<HTMLButtonElement>("connect");
const statusEl = $("status");
const promptInput = $<HTMLInputElement>("prompt");
const sendBtn = $<HTMLButtonElement>("send");
const replyEl = $("reply");

let sdk: UnifiedAI | undefined;
let unsubscribe: (() => void) | undefined;

connectBtn.addEventListener("click", () => {
  const token = tokenInput.value.trim();
  if (!token) {
    statusEl.textContent = "session: paste a token first";
    return;
  }

  unsubscribe?.(); // drop the previous client's subscription, if any
  sdk = new UnifiedAI({ token, apiUrl: API_URL });

  // `session.onChange` returns an unsubscribe function. In trusted-token mode
  // the session starts out "active"; events fire on refresh/expiry/errors.
  unsubscribe = sdk.session.onChange((event) => {
    statusEl.textContent = `session: ${event.session.status} (last event: ${event.type})`;
  });

  statusEl.textContent = `session: ${sdk.session.status} — connected`;
  sendBtn.disabled = false;
});

sendBtn.addEventListener("click", () => {
  void sendPrompt();
});

async function sendPrompt(): Promise<void> {
  if (!sdk) return;
  sendBtn.disabled = true;
  replyEl.textContent = "…thinking…";
  try {
    const response = await sdk.chat.completions.create({
      model: "auto",
      messages: [{ role: "user", content: promptInput.value }],
    });
    replyEl.textContent = response.choices[0]?.message.content ?? "(empty reply)";
  } catch (err) {
    replyEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    sendBtn.disabled = false;
  }
}
