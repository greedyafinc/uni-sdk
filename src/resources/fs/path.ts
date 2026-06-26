// Path normalization + jail enforcement for `sdk.fs`. Every path that crosses
// the facade is run through `normalizeRelPath` first: it collapses `.`/`..`
// segments, rejects anything that escapes the namespace root, and returns a
// clean POSIX-relative string the backends can treat as an opaque key.
//
// This is the SDK-side half of the jail (the analog of OpenDesign's
// `resolveInside`). For untrusted apps the host re-enforces at the IPC boundary;
// this layer keeps honest apps honest and catches bugs early.
import { fsError } from "./errors";

/**
 * Normalize a caller-supplied path to a safe namespace-relative POSIX path.
 * Throws `invalid_path` for absolute paths, empty paths, or any input that
 * traverses above the root. The returned value never starts with `/` or `.`
 * and never contains a `..` segment.
 */
export function normalizeRelPath(input: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw fsError("invalid_path", "path must be a non-empty string");
  }
  // Normalize separators and reject Windows drive letters / UNC up front.
  const raw = input.replace(/\\/g, "/");
  if (raw.startsWith("/")) {
    throw fsError("invalid_path", `path must be relative, got "${input}"`);
  }
  if (/^[a-zA-Z]:/.test(raw)) {
    throw fsError("invalid_path", `path must not be absolute, got "${input}"`);
  }
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // Escaping the root is never allowed — a `..` that would pop past the
      // start means the caller is trying to break out of the jail.
      if (out.length === 0) {
        throw fsError("invalid_path", `path escapes the namespace root: "${input}"`);
      }
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) {
    throw fsError("invalid_path", `path resolves to the namespace root: "${input}"`);
  }
  return out.join("/");
}

/** Normalize a directory prefix for `list()` — like a path, but the root ("") is allowed. */
export function normalizePrefix(input: string | undefined): string {
  if (input === undefined || input === "" || input === "/" || input === ".") return "";
  return normalizeRelPath(input);
}

/**
 * Normalize a namespace id to a single safe directory component, mirroring the
 * native backend's `sanitize_ns` so the SAME id resolves identically in both
 * runtimes. Empty maps to the shared "default" namespace; `.`/`..`/separators
 * and anything outside `[A-Za-z0-9._-]` are REJECTED (not lossily transformed,
 * which would let distinct ids collide into one tree); the result is lowercased
 * so case-variants can't alias on a case-insensitive filesystem.
 */
export function normalizeNs(input: string | undefined): string {
  const ns = (input ?? "").trim();
  if (ns === "") return "default";
  if (ns === "." || ns === ".." || /[/\\\0]/.test(ns)) {
    throw fsError("invalid_input", `invalid namespace: ${JSON.stringify(input)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(ns)) {
    throw fsError("invalid_input", `invalid namespace: ${JSON.stringify(input)}`);
  }
  return ns.toLowerCase();
}
