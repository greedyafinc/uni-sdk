export declare function formatBody(body: unknown): string;
/**
 * Pulls a human-readable message out of common server error body shapes:
 * - plain string body
 * - `{message: "..."}`
 * - `{error: "..."}` or `{error: {message: "..."}}`
 * - `{detail: "..."}` (FastAPI) or `{detail: [{msg: "..."}, ...]}` (FastAPI validation)
 * - `{errors: [{message: "..."}, ...]}`
 *
 * All returned messages are capped to MAX_ERROR_BODY_CHARS to prevent
 * unbounded server payloads from flooding Error.message.
 */
export declare function extractServerMessage(body: unknown): string | undefined;
export declare function httpErrorMessage(verb: string, path: string, status: number, body: unknown): string;
export declare function drainResponse(res: Response): Promise<void>;
export declare function readErrorBody(res: Response): Promise<unknown>;
//# sourceMappingURL=http-errors.d.ts.map