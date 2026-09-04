import type { Model } from "./models.js";
/** How a costlier pick is allowed to run without asking every time. */
export type StepUpPolicy = "stay" | "ask" | "auto";
/** One job, one model. The unit a dispatch resolves to when the request is simple. */
export interface AutoProfile {
    id: string;
    name: string;
    /** Null when the catalogue has nothing that fits — the profile exists but is unusable. */
    modelId: string | null;
    useWhen: string;
    systemPrompt?: string;
    /** True when this profile is dearer than the everyday model, and so gated by `stepUp`. */
    costsMore?: boolean;
}
export type StageKind = "plan" | "work" | "test";
/** One stage of a sequence. A `work` stage may list a fallback fast-worker for mechanical steps. */
export interface AutoStage {
    kind: StageKind;
    profileIds: string[];
}
/** Plan → work → test across possibly several files, retried a bounded number of times. */
export interface AutoSequence {
    id: string;
    name: string;
    useWhen: string;
    stages: AutoStage[];
    retries: number;
}
export interface AutoConfig {
    dispatcherModelId: string | null;
    everydayId: string;
    profiles: AutoProfile[];
    sequences: AutoSequence[];
    stepUp: StepUpPolicy;
    /** Fall back to `fallbackDispatch` when the dispatcher model's reply cannot be parsed. */
    hintsFallback: boolean;
}
export type AutoDispatch = {
    kind: "profile" | "sequence";
    id: string;
    why: string;
};
export type GateDecision = {
    action: "run";
} | {
    action: "ask";
} | {
    action: "hold";
    declined: AutoDispatch;
};
export interface PlanStep {
    title: string;
    criterion: string;
    /** A precise-enough spec that a cheaper model can carry it out (renames, boilerplate, formatting). */
    mechanical: boolean;
}
export interface TestResult {
    criterion: string;
    pass: boolean;
    evidence: string;
}
/**
 * The shipped defaults, built from a catalogue. Each profile picks the first
 * model matching its hints, in order; a profile whose hints all miss just
 * gets the everyday model, so dispatch always has something to run.
 */
export declare function defaultConfig(models: Model[]): AutoConfig;
export declare function profileById(config: AutoConfig, id: string): AutoProfile | undefined;
export declare function sequenceById(config: AutoConfig, id: string): AutoSequence | undefined;
/** The one-shot prompt for the dispatcher model: every option, and how to answer. */
export declare function dispatchPrompt(config: AutoConfig, text: string, ctx?: {
    codeWork?: boolean;
    needsVision?: boolean;
}): string;
/** Read the dispatcher's reply. Null when it named nothing this config knows. */
export declare function parseDispatch(raw: string, config: AutoConfig): AutoDispatch | null;
/**
 * No model available (or the dispatcher's reply didn't parse): fall back to
 * the same signals `autoModel` uses, mapped onto profiles and sequences
 * instead of a bare model id.
 */
export declare function fallbackDispatch(config: AutoConfig, req: {
    text: string;
    effort?: "low" | "medium" | "high" | null;
    codeWork?: boolean;
    needsVision?: boolean;
}): AutoDispatch;
/** Whether running this pick can spend more than the everyday model. */
export declare function costsMore(pick: AutoDispatch, config: AutoConfig): boolean;
/**
 * The one place a costlier pick is allowed to run. `stay` never spends more
 * on its own — it hands the pick back as `declined` so the host can offer it
 * — `ask` wants a per-turn yes, `auto` (or a session that already said yes)
 * just runs it.
 */
export declare function gate(pick: AutoDispatch, config: AutoConfig, opts?: {
    sessionAllowed?: boolean;
}): GateDecision;
/** Which profile carries out a plan step: the fallback fast-worker when the step is mechanical. */
export declare function pickWorker(step: PlanStep, stage: AutoStage): string;
export declare function planPrompt(request: string): string;
export declare function parsePlan(raw: string): PlanStep[] | null;
export declare function stepPrompt(request: string, step: PlanStep, ctx: {
    index: number;
    total: number;
    priorNotes: string[];
    failure?: string;
}): string;
export declare function testPrompt(request: string, steps: PlanStep[], workNotes: string[]): string;
export declare function parseTestReport(raw: string, steps: PlanStep[]): TestResult[] | null;
//# sourceMappingURL=autoRouter.d.ts.map