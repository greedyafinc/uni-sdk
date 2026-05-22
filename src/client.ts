import { Core, type CoreOptions } from "./core";

export interface UnifiedAIOptions extends CoreOptions {}

/**
 * Entry point for `@unifiedai/sdk`.
 *
 * Resources are attached as instance properties as they're built — see
 * `ARCHITECTURE.md` for the pattern.
 */
export class UnifiedAI extends Core {
  constructor(options: UnifiedAIOptions = {}) {
    super(options);
  }
}
