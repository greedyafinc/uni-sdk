/**
 * Shallow-merge `patch` over `base`. A JSON `null` value REMOVES that key (the
 * documented delete-a-field convention); any other value overwrites. `base` is
 * not mutated.
 */
export declare function mergePatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown>;
//# sourceMappingURL=merge.d.ts.map