// Shared base64 codec — the single implementation behind every resource that
// moves binary payloads through JSON (storage/fs blobs, sync ops, artifact
// previews, project snapshots, reference resyncs, multimodal helpers, file
// uploads) plus the PKCE base64url challenge.
//
// Browser-safe by construction: no `node:` imports. Node's `Buffer` is used as
// a fast path only when it exists on `globalThis` (feature-detected per call so
// tests can simulate the browser by deleting it); otherwise we fall back to
// `btoa`/`atob`.
//
// Semantics:
// - Standard alphabet, padded output (`bytesToBase64`); `bytesToBase64Url`
//   applies the url-safe alphabet and strips padding.
// - A `Uint8Array` view with a non-zero `byteOffset`/short `length` encodes
//   ONLY its window (both `Buffer.from(view)` and `subarray` respect the view).
// - Decoding strips whitespace first — line-wrapped base64 (PEM, `openssl
//   base64`, textarea copy-paste) is common; Node tolerates it but browser
//   `atob` throws InvalidCharacterError.
// - Decoded bytes are always a fresh, un-aliased `Uint8Array` (never a view
//   into Node's shared Buffer pool), so callers may safely use `.buffer`.

interface BufferLike {
  toString(enc: "base64"): string;
}

interface BufferCtor {
  from(data: Uint8Array): BufferLike;
  from(data: string, enc: "base64"): Uint8Array;
}

function nodeBuffer(): BufferCtor | undefined {
  return (globalThis as { Buffer?: BufferCtor }).Buffer;
}

/** Encode bytes → standard base64 (padded). */
export function bytesToBase64(bytes: Uint8Array): string {
  const B = nodeBuffer();
  // Buffer.from(view) copies exactly the view's window — fast and length-safe.
  if (B !== undefined) return B.from(bytes).toString("base64");
  if (typeof btoa === "function") {
    // Chunked String.fromCharCode: spreading the whole array throws RangeError
    // above ~100K elements. 4K chunks stay well under Safari/JSC's ~10K
    // argument-count limit while amortising per-call overhead so multi-MB
    // payloads encode in roughly linear time.
    let bin = "";
    const CHUNK = 0x1000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.subarray(i, i + CHUNK);
      bin += String.fromCharCode(...(slice as unknown as number[]));
    }
    return btoa(bin);
  }
  throw new Error("no base64 encoder available (neither Buffer nor btoa)");
}

/** Encode bytes → base64url (url-safe alphabet, no padding). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Decode standard base64 → bytes. Whitespace-tolerant; returns a fresh array. */
export function base64ToBytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/\s+/g, "");
  const B = nodeBuffer();
  // Copy out of the Buffer: Buffer.from(str) is a view into Node's shared
  // pool, and we promise callers an un-aliased array.
  if (B !== undefined) return new Uint8Array(B.from(cleaned, "base64"));
  if (typeof atob === "function") {
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw new Error("no base64 decoder available (neither Buffer nor atob)");
}
