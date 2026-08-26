export interface StreamUsage {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    elapsed_ms: number;
    tokens_per_second: number;
}
export type StreamUsageExtractor<T> = (event: T) => Pick<StreamUsage, "input_tokens" | "output_tokens" | "total_tokens"> | null | undefined;
export declare class UnifiedStream<T> implements AsyncIterable<T> {
    private readonly source;
    private readonly controller;
    private readonly extractor?;
    private aborted;
    private readonly startedAt;
    usage: StreamUsage | null;
    constructor(source: AsyncGenerator<T, void, void>, controller: AbortController, extractor?: StreamUsageExtractor<T> | undefined);
    abort(): void;
    [Symbol.asyncIterator](): AsyncGenerator<T, void, void>;
}
//# sourceMappingURL=stream.d.ts.map