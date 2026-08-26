import { registerActions } from "@unified/host-api";
import {
  makeOpenArtifactAdapter,
  notFound,
  requiredParam,
  safeRegisterActions,
} from "@unifiedai/sdk/app";
// Remote entry (lib mode → app.js, the manifest's `module`). The host imports
// this module to mount the app; it must register the manifest-declared action
// handlers at MODULE SCOPE (the host may warm-load the bundle and invoke an
// action without ever mounting the UI) and default-export the root component.
import App from "./App.vue";
import { getItem, openItem } from "./store";

const ID_HINT = "Item ids come from a My App search hit.";

function open(itemId: string): { ok: true } {
  if (!itemId) throw new Error(requiredParam("itemId", ID_HINT));
  if (!getItem(itemId)) throw new Error(notFound("Item", itemId, ID_HINT));
  openItem(itemId);
  return { ok: true };
}

// `safeRegisterActions` owns the module-scope + fail-soft contract: in
// standalone dev the host-api shim's registerActions is a no-op, and on a host
// too old to expose it the app still loads — only the chat actions are absent.
safeRegisterActions("my-app", () => {
  registerActions({
    async openItem(params) {
      const { itemId } = params as { itemId?: string };
      return open(itemId ?? "");
    },
    // The ecosystem-standard open verb (declared verbatim from
    // OPEN_ARTIFACT_SPEC in the manifest): every cross-app pointer — a search
    // hit, an @-mention, a project link — arrives here, adapted onto the
    // app's own open action, which keeps ownership of validation + errors.
    openArtifact: makeOpenArtifactAdapter(({ objectId }) => open(objectId)),
  });
});

export default App;
