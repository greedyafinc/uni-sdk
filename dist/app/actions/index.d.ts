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
export declare function makeOpenArtifactAdapter<R>(open: (ref: OpenArtifactRef) => R | Promise<R>): (params: unknown) => Promise<R>;
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
export declare function safeRegisterActions(appName: string, register: () => void): void;
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
export declare function requiredParam(name: string, hint?: string): string;
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
export declare function notFound(noun: string, id: string, idSourceHint?: string): string;
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
export declare function storageUnavailable(appName: string, verbPhrase: string): string;
//# sourceMappingURL=index.d.ts.map