// The built-in hints behind Auto: a name-based guess over a catalogue, and a
// guess at what kind of work a request is from what the user has already said
// (the words, the effort they picked, whether a workspace is attached).
//
// These are the FALLBACK for `autoRouter` — used when the dispatcher model
// cannot be reached or its reply does not parse — and the seed for its shipped
// defaults. They never choose a model on their own any more; the dispatcher
// and the user's "use when" sentences do that.
//
// Pure: no transport, no client, no I/O.
import type { Model } from "./models";

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

/** Long enough that the request is unlikely to be a quick question. */
const LONG_TEXT = 1200;

/** Words that say the user wants thinking, not just an answer. */
const DEEP_WORDS =
  /\b(plan|architect|architecture|design the|refactor|debug|diagnose|root cause|trade[- ]?offs?|why does|why is|prove|derive|migrate|strategy)\b/i;

/** Words that say the work is visual. */
const DESIGN_WORDS =
  /\b(design|mockup|wireframe|ui|ux|layout|typography|palette|brand|logo|poster|landing page)\b/i;

/** First model matching any hint, in hint order — a name-based guess, shared with autoRouter. */
export function firstByHint(models: Model[], hints: string[]): Model | undefined {
  for (const hint of hints) {
    const match = models.find((m) => `${m.id} ${m.name}`.toLowerCase().includes(hint));
    if (match) return match;
  }
  return undefined;
}

/** Which kind of work this turn looks like, from what the user has already said. */
export function roleFor(req: AutoRoleRequest): AutoRole {
  if (req.needsVision) return "vision";
  if (DESIGN_WORDS.test(req.text) && !req.codeWork) return "design";
  if (req.effort === "high") return "deep";
  if (req.effort === "low") return "fast";
  if (req.codeWork) return "deep";
  if (DEEP_WORDS.test(req.text)) return "deep";
  if (req.text.length >= LONG_TEXT) return "deep";
  return "fast";
}
