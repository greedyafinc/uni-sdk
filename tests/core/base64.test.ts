// Shared base64 codec (src/core/_internal/base64.ts) — the single
// implementation behind storage/fs blobs, sync ops, artifact previews, project
// snapshots, reference resyncs, multimodal helpers, file uploads, and PKCE.
//
// The large-payload cases are the regression tests for references.resync: the
// old inline encoder spread a whole Uint8Array into String.fromCharCode, which
// throws RangeError above ~100K elements.
import { describe, expect, it } from "bun:test";

import { base64ToBytes, bytesToBase64, bytesToBase64Url } from "../../src/core/_internal/base64";

/** Run `fn` with `globalThis.Buffer` hidden, forcing the btoa/atob path. */
function withoutBuffer<T>(fn: () => T): T {
  const g = globalThis as { Buffer?: unknown };
  const saved = g.Buffer;
  // biome-ignore lint/performance/noDelete: restoring afterwards; feature-detect must see it absent
  delete g.Buffer;
  try {
    return fn();
  } finally {
    g.Buffer = saved;
  }
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // crypto.getRandomValues caps at 64KB per call.
  for (let i = 0; i < n; i += 65536) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)));
  }
  return out;
}

describe("bytesToBase64", () => {
  it("encodes known vectors with standard alphabet and padding", () => {
    const enc = new TextEncoder();
    expect(bytesToBase64(enc.encode(""))).toBe("");
    expect(bytesToBase64(enc.encode("f"))).toBe("Zg==");
    expect(bytesToBase64(enc.encode("fo"))).toBe("Zm8=");
    expect(bytesToBase64(enc.encode("foo"))).toBe("Zm9v");
    expect(bytesToBase64(enc.encode("hello world"))).toBe("aGVsbG8gd29ybGQ=");
    // Bytes that exercise the +/ alphabet positions.
    expect(bytesToBase64(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe("+//+");
  });

  it("round-trips a >200KB payload without RangeError (references.resync regression)", () => {
    const bytes = randomBytes(300_000);
    const b64 = bytesToBase64(bytes);
    expect(base64ToBytes(b64)).toEqual(bytes);
  });

  it("round-trips a >200KB payload on the browser (btoa) path", () => {
    const bytes = randomBytes(300_000);
    const b64 = withoutBuffer(() => bytesToBase64(bytes));
    expect(withoutBuffer(() => base64ToBytes(b64))).toEqual(bytes);
  });

  it("browser path produces byte-identical output to the Buffer path", () => {
    for (const n of [0, 1, 2, 3, 0xfff, 0x1000, 0x1001, 100_003]) {
      const bytes = randomBytes(n);
      const viaBuffer = bytesToBase64(bytes);
      const viaBtoa = withoutBuffer(() => bytesToBase64(bytes));
      expect(viaBtoa).toBe(viaBuffer);
    }
  });

  it("encodes only the window of a subarray view with byteOffset", () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const view = backing.subarray(2, 5); // [3, 4, 5]
    expect(view.byteOffset).toBe(2);
    const expected = bytesToBase64(new Uint8Array([3, 4, 5]));
    expect(bytesToBase64(view)).toBe(expected);
    expect(withoutBuffer(() => bytesToBase64(view))).toBe(expected);
    expect(base64ToBytes(bytesToBase64(view))).toEqual(new Uint8Array([3, 4, 5]));
  });
});

describe("base64ToBytes", () => {
  it("decodes known vectors", () => {
    expect(base64ToBytes("")).toEqual(new Uint8Array(0));
    expect(base64ToBytes("Zg==")).toEqual(new TextEncoder().encode("f"));
    expect(base64ToBytes("aGVsbG8gd29ybGQ=")).toEqual(new TextEncoder().encode("hello world"));
  });

  it("tolerates line-wrapped / whitespace-padded input on both paths", () => {
    const wrapped = "aGVs\nbG8g\r\nd29y bGQ=\n";
    const expected = new TextEncoder().encode("hello world");
    expect(base64ToBytes(wrapped)).toEqual(expected);
    expect(withoutBuffer(() => base64ToBytes(wrapped))).toEqual(expected);
  });

  it("returns a fresh un-aliased array (safe .buffer, zero byteOffset)", () => {
    const out = base64ToBytes("aGVsbG8=");
    expect(out.byteOffset).toBe(0);
    expect(out.buffer.byteLength).toBe(out.length);
  });

  it("browser path matches the Buffer path", () => {
    const b64 = bytesToBase64(randomBytes(10_000));
    expect(withoutBuffer(() => base64ToBytes(b64))).toEqual(base64ToBytes(b64));
  });
});

describe("bytesToBase64Url", () => {
  it("uses the url-safe alphabet and strips padding", () => {
    // 0xfb 0xff 0xfe → "+//+" in standard base64 → "-__-" url-safe.
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe("-__-");
    expect(bytesToBase64Url(new TextEncoder().encode("f"))).toBe("Zg"); // no padding
  });

  it("matches RFC 7636 PKCE appendix B challenge encoding", () => {
    // RFC 7636 Appendix B: this 32-byte digest encodes to the given challenge.
    const digest = new Uint8Array([
      19, 211, 30, 150, 26, 26, 216, 236, 47, 22, 177, 12, 76, 152, 46, 8, 118, 168, 120, 173, 109,
      241, 68, 86, 110, 225, 137, 74, 203, 112, 249, 195,
    ]);
    expect(bytesToBase64Url(digest)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(withoutBuffer(() => bytesToBase64Url(digest))).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});
