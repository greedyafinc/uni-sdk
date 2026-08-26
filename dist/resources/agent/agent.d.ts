import type { Core } from "../../core/core.js";
import type { RunAgentOptions, RunAgentResult } from "./types.js";
/**
 * Tool-loop scaffolding. `sdk.agent.run(...)` runs the model with the app's
 * prompt + tools, dispatching tool-calls to the app's executors until the model
 * stops or `maxSteps` is hit. No prompt or tool policy is baked in.
 */
export declare class Agent {
    private readonly completions;
    constructor(client: Core);
    run(options: RunAgentOptions): Promise<RunAgentResult>;
}
//# sourceMappingURL=agent.d.ts.map