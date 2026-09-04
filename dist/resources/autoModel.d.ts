import type { Model } from "./models.js";
/** What a turn looks like it is for. */
export type AutoRole = "fast" | "deep" | "design" | "vision";
export interface AutoRoleRequest {
    /** The message about to be sent. Its words are the main signal. */
    text: string;
    /** The effort the user picked in the composer, when the surface offers one. */
    effort?: "low" | "medium" | "high" | null;
    /** True when the turn attaches a code workspace: the work edits real files. */
    codeWork?: boolean;
    /** True when the turn carries an image or PDF, so the model must accept one. */
    needsVision?: boolean;
}
/** First model matching any hint, in hint order — a name-based guess, shared with autoRouter. */
export declare function firstByHint(models: Model[], hints: string[]): Model | undefined;
/** Which kind of work this turn looks like, from what the user has already said. */
export declare function roleFor(req: AutoRoleRequest): AutoRole;
//# sourceMappingURL=autoModel.d.ts.map