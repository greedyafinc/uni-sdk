import { UnifiedAI } from "../core/client.js";
import type { ProjectContext } from "../host-api.js";
import { fsTools } from "../resources/agent/fs-tools.js";
import { getProviderLogo } from "../resources/logos.js";
export declare function getSdk(): UnifiedAI;
export { getProviderLogo, fsTools };
export declare function getTheme(): "light" | "dark";
export declare function onThemeChange(cb: (theme: "light" | "dark") => void): () => void;
export declare function registerActions(_handlers: Record<string, (params: Record<string, unknown>, ctx: unknown) => unknown>): () => void;
export declare function runAgent(): never;
export declare function hasRunAgent(): boolean;
export declare function listModels(): Promise<null>;
export declare function isLocalAgentModel(): boolean;
/** No host usage source in standalone dev — callers fall back to `getSdk().usage`. */
export declare function getUsage(): Promise<null>;
/** No project context in standalone dev. */
export declare function getCurrentProject(): ProjectContext | null;
/**
 * Fires once with `null` (the bridge fires immediately with the current
 * context, which standalone dev never has) and never again; the unsubscribe
 * is a no-op.
 */
export declare function onProjectChange(cb: (project: ProjectContext | null) => void): () => void;
/**
 * Resolves to null — the bridge's "there is no shell" outcome — so apps take
 * their documented fallback and surface the artifact in their own UI.
 */
export declare function openArtifact(): Promise<null>;
//# sourceMappingURL=dev-host-api.d.ts.map