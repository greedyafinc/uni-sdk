export interface SSEMessage {
    event?: string;
    data: string;
    id?: string;
}
export declare function parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage, void, void>;
//# sourceMappingURL=sse.d.ts.map