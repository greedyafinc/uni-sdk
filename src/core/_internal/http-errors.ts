// HTTP error-body helpers. Lifted out of core/client.ts so the node entry can
// re-export them without dragging the base UnifiedAI class into the bundle
// (a name collision with the node subclass confuses Bun's bundler).

// Cap the length of server-body excerpts in error messages so a runaway HTML
// error page doesn't flood the surfaced UnifiedAIError.message.
const MAX_ERROR_BODY_CHARS = 400;

function clip(s: string): string {
  return s.length > MAX_ERROR_BODY_CHARS ? s.slice(0, MAX_ERROR_BODY_CHARS) : s;
}

export function formatBody(body: unknown): string {
  if (body === undefined || body === null) return "<empty body>";
  if (typeof body === "string") return clip(body);
  try {
    return clip(JSON.stringify(body));
  } catch {
    return "<unserializable body>";
  }
}

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
export function extractServerMessage(body: unknown): string | undefined {
  if (typeof body === "string") {
    const trimmed = body.trim();
    return trimmed ? clip(trimmed) : undefined;
  }
  if (!body || typeof body !== "object") return undefined;
  const obj = body as Record<string, unknown>;

  if (typeof obj.message === "string" && obj.message) return clip(obj.message);

  const err = obj.error;
  if (typeof err === "string" && err) return clip(err);
  if (err && typeof err === "object") {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === "string" && m) return clip(m);
  }

  const detail = obj.detail;
  if (typeof detail === "string" && detail) return clip(detail);
  if (Array.isArray(detail) && detail.length > 0) {
    const msgs = detail
      .map((d) => (d && typeof d === "object" ? (d as Record<string, unknown>).msg : undefined))
      .filter((m): m is string => typeof m === "string" && m.length > 0);
    if (msgs.length > 0) return clip(msgs.join("; "));
  }

  const errors = obj.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const msgs = errors
      .map((e) =>
        e && typeof e === "object" ? (e as Record<string, unknown>).message : undefined,
      )
      .filter((m): m is string => typeof m === "string" && m.length > 0);
    if (msgs.length > 0) return clip(msgs.join("; "));
  }

  return undefined;
}

export function httpErrorMessage(
  verb: string,
  path: string,
  status: number,
  body: unknown,
): string {
  const base = `${verb} to ${path} returned ${status}`;
  const server = extractServerMessage(body);
  return server ? `${base}: ${server}` : base;
}

export async function drainResponse(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    // ignore
  }
}

export async function readErrorBody(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
