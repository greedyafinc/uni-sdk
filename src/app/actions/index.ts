// Shared kernel for the HOST-ACTION plumbing every micro-app repeats — import
// from "@unifiedai/sdk/app".
//
// Five apps (docs, sheets, notes, planner, design) each register a handler map
// with `registerActions` from @unified/host-api and each throw plain Errors the
// host wraps as E_APP_ERROR. Three things had been copy-pasted across all five
// and — as always — had drifted where it mattered:
//
//   1. The `openArtifact` adapter. FIVE near-identical shims onto each app's own
//      model-facing open action, four of them carrying a VERBATIM copy of the
//      same five-line comment. The comment is the interesting part and it now
//      lives exactly once, on `makeOpenArtifactAdapter` below.
//   2. The `try { registerActions(...) } catch { console.warn(...) }` wrapper.
//      Identical in all five entries, down to the warning's wording, with only
//      the app name varying — see `safeRegisterActions`.
//   3. The three error-message shapes every handler hand-writes: "param is
//      required", "noun not found: id" plus an id-source hint, and "storage is
//      unavailable". SIX different phrasings of the storage one existed; design
//      repeated one not-found string verbatim three times and a near-variant a
//      fourth; docs repeated its own twice; notes had already extracted an
//      ID_HELP constant for half of it. The builders below converge them on the
//      docs/sheets em-dash family while keeping each app's own id-source hint,
//      which is the part that genuinely differs per app.
//
// What is deliberately NOT here: anything that knows an app's content model or
// its routing. Each app keeps its own open action, its own hash/route scheme,
// and its own id-source hint text; this module only supplies the envelope.
//
// Lives in the SDK (formerly the UnifiedApp workspace's @unified/app-actions
// source alias) so the UnifiedApp host, its bundled apps, AND third-party
// marketplace apps all share one copy. This file imports NOTHING — no Vue, no
// other SDK module, not even `@unified/host-api` (see `safeRegisterActions`,
// which takes the call as a thunk precisely so this module stays free of it) —
// so it is equally usable from a remote `app.js` entry, a headless host-action
// path, and a bun test.

// ─── openArtifact ────────────────────────────────────────────────────────────

/**
 * The parameters of the ecosystem-standard open verb, matched STRUCTURALLY so
 * nothing here imports the SDK's `OpenArtifactParams` (see the module header).
 * `objectId` is non-optional and normalized to `""` when absent, which is the
 * shape every adapter's callback wants: the app's own open action is the one
 * that owns the "id is required" error, with the app's own id-source hint.
 */
export interface OpenArtifactRef {
  /** The artifact's app-local id. `""` when the caller sent none. */
  objectId: string;
  /** The platform's opaque portion locator, when the pointer captured one. */
  fragment?: unknown;
  /** The artifact's kind, when the surface that produced the pointer knew it. */
  kind?: string;
  /** The collection the id belongs to, when the surface knew it. */
  collection?: string;
}

/**
 * Build this app's `openArtifact` handler from its own open action.
 *
 * ── Why every app has one ──
 * `openArtifact` is the ecosystem-standard open verb (@unifiedai/sdk
 * OPEN_ARTIFACT_SPEC). Every surface that holds a pointer INTO an app —
 * cross-app search, @-mentions, project links, references — arrives here, so
 * none of them need to know that app's own action names. It is deliberately a
 * thin adapter onto the app's model-facing open action, which stays the richer,
 * better-described one for the agent: the agent gets a tool that talks about
 * documents/sheets/notes/designs, and the platform gets one verb it can call
 * everywhere.
 *
 * ── What the callback receives ──
 * All four fields, normalized. Most apps need only `objectId`. Two do more, and
 * both are genuine app-model decisions rather than boilerplate, which is why
 * they live in the callback and not in here:
 *  - sheets reads `fragment` — a portion of a spreadsheet is a tab and/or a
 *    range, so a link captured from a selection reopens on that selection
 *    rather than at A1.
 *  - planner reads `kind` — it decides the destination, so it is required there
 *    rather than a hint: a search hit's kind and a ProjectLink's artifactType
 *    both carry it, and `openItem` rejects an id that belongs to a different
 *    kind.
 *
 * ── Why it does not validate ──
 * A missing `objectId` becomes `""` and is passed straight through. The app's
 * open action already rejects an empty id, and it does so with that app's own
 * id-source hint ("Use sheets__listSheets…", "Note ids come from…") — advice
 * this module has no way to write. Validating here would replace a useful
 * message with a generic one. The one app that DOES check `objectId` itself
 * (design) needs to, because its project branch reads the id before delegating
 * to any action that would validate it.
 */
export function makeOpenArtifactAdapter<R>(
  open: (ref: OpenArtifactRef) => R | Promise<R>,
): (params: unknown) => Promise<R> {
  return async (params: unknown): Promise<R> => {
    const p = (params ?? {}) as Partial<OpenArtifactRef>;
    return await open({
      objectId: typeof p.objectId === "string" ? p.objectId : "",
      ...(p.fragment === undefined ? {} : { fragment: p.fragment }),
      ...(typeof p.kind === "string" ? { kind: p.kind } : {}),
      ...(typeof p.collection === "string" ? { collection: p.collection } : {}),
    });
  };
}

// ─── registerActions ─────────────────────────────────────────────────────────

/**
 * Run an app entry's `registerActions(...)` call, swallowing the two failures
 * that are NOT bugs.
 *
 * Registration must happen at MODULE SCOPE: the host may warm-LOAD a remote
 * without mounting anything (apps/desktop src/apps/ensureAppLoaded.ts warmApp,
 * driven by src/apps/search/openHit.ts) and invoke straight away, so a handler
 * registered from a component's `onMounted` would not exist on that cold path.
 * Module scope is also what makes the failure worth catching: a throw there
 * takes the whole module load down, and with it the app.
 *
 * Two things can throw, and neither is worth crashing over:
 *  - standalone dev, where `@unified/host-api` resolves to the app's own
 *    dev-host-api no-op shim;
 *  - a host too old to expose `registerActions` at all.
 * In both cases the app itself still works; only the chat actions are absent.
 *
 * `register` is a THUNK rather than a handler map so this module never has to
 * import `registerActions` — or its `ActionHandlers` type — from
 * `@unified/host-api`, which is externalized in every app's remote build and
 * therefore must not be reachable from a shared source module. The caller keeps
 * full, unwidened typing of its own handler map.
 */
export function safeRegisterActions(appName: string, register: () => void): void {
  try {
    register();
  } catch (err) {
    console.warn(`[${appName}] registerActions failed (standalone dev or old host):`, err);
  }
}

// ─── Error messages ──────────────────────────────────────────────────────────
//
// ONE phrasing family, the em-dash style docs and sheets already used: a short
// declarative first sentence, then — after an em dash or as a second sentence —
// the thing the caller should do about it. The host wraps whatever these return
// as E_APP_ERROR and hands it back to the model, so the second half is the part
// that actually earns its keep: a model that is told "not found" and nothing
// else will guess another id.
//
// These return STRINGS, not Errors, so a caller can compose (`throw new
// Error(notFound(...))`) without a helper deciding its own error class.

/**
 * "`name` is required." — a missing or empty required parameter.
 *
 * `hint` is appended after an em dash and should be a complete clause INCLUDING
 * its terminating period, because what belongs there varies: some apps explain
 * what the parameter means ("it becomes the new note's title"), others explain
 * where to get a valid value (`notFound`'s id-source hints). Omit it when the
 * parameter name is self-explanatory and the app's other errors already carry
 * the sourcing advice.
 */
export function requiredParam(name: string, hint?: string): string {
  return hint ? `${name} is required — ${hint}` : `${name} is required.`;
}

/**
 * "`noun` not found: `id`." plus, when given, the app's id-source hint.
 *
 * `idSourceHint` is the one part of this that is genuinely per-app and must NOT
 * be centralized: it names the action or surface a real id comes from
 * ("Use sheets__listSheets to see available sheets.", "Use design__listDesigns
 * to see available project and design ids.", docs' "ids come from a search hit
 * or docs__createDocument — Docs has no list action"). A model handed "not
 * found" with no sourcing advice invents another id; handed the advice, it goes
 * and gets a real one. Pass it as a complete sentence including its period.
 *
 * Keep this distinct from `storageUnavailable`. Both surface as "the thing you
 * asked for isn't there", but only one of them means the caller's id is wrong —
 * every one of these apps has a fail-soft store that returns null for BOTH, and
 * conflating them sends a caller off hunting for an id it already had.
 */
export function notFound(noun: string, id: string, idSourceHint?: string): string {
  const head = `${noun} not found: ${id}.`;
  return idSourceHint ? `${head} ${idSourceHint}` : head;
}

/**
 * "`appName` storage is unavailable — `verbPhrase`." — the store itself is
 * absent, as distinct from the requested row being absent (see `notFound`).
 *
 * `verbPhrase` names what fell over from the CALLER's point of view, without a
 * trailing period: "cannot open the document", "cannot list spreadsheets",
 * "the document was not updated". That is what tells a model whether its write
 * landed, which a bare "storage is unavailable" does not.
 *
 * `appName` is the app's display name ("Docs", "Sheets", "Design"), not its
 * lowercase manifest id — this string is read by a human as often as by a model.
 */
export function storageUnavailable(appName: string, verbPhrase: string): string {
  return `${appName} storage is unavailable — ${verbPhrase}.`;
}
