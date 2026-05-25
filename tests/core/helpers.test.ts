import { describe, expect, test } from "bun:test";
import {
  Helpers,
  UnifiedError,
  toChatAudioPart,
  toChatFilePart,
  toChatImagePart,
  toChatVideoPart,
  toMessagesDocumentPart,
  toMessagesImagePart,
  toResponsesAudioPart,
  toResponsesFilePart,
  toResponsesImagePart,
  toResponsesVideoPart,
} from "../../src/index";

// Minimal magic-byte fixtures so detection-by-content has something to match.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const WAV = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0]);

// ────────────────────────────────────────────────────────────────────────────
// Chat parts
// ────────────────────────────────────────────────────────────────────────────

describe("toChatImagePart", () => {
  test("Uint8Array PNG → data URL with detected mime", async () => {
    const part = await toChatImagePart(PNG);
    expect(part.type).toBe("image_url");
    expect(part.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("JPEG bytes detect image/jpeg", async () => {
    const part = await toChatImagePart(JPEG);
    expect(part.image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  test("GIF bytes detect image/gif", async () => {
    const part = await toChatImagePart(GIF);
    expect(part.image_url.url.startsWith("data:image/gif;base64,")).toBe(true);
  });

  test("WebP bytes detect image/webp", async () => {
    const part = await toChatImagePart(WEBP);
    expect(part.image_url.url.startsWith("data:image/webp;base64,")).toBe(true);
  });

  test("http URL string passes through verbatim", async () => {
    const part = await toChatImagePart("https://example.com/x.png");
    expect(part.image_url.url).toBe("https://example.com/x.png");
  });

  test("data URL string passes through verbatim", async () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const part = await toChatImagePart(dataUrl);
    expect(part.image_url.url).toBe(dataUrl);
  });

  test("detail option threads through", async () => {
    const part = await toChatImagePart(PNG, { detail: "high" });
    expect(part.image_url.detail).toBe("high");
  });

  test("mimeType option overrides detection", async () => {
    const part = await toChatImagePart(JPEG, { mimeType: "image/png" });
    expect(part.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("Blob input uses Blob.type when present", async () => {
    const blob = new Blob([PNG], { type: "image/png" });
    const part = await toChatImagePart(blob);
    expect(part.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("file_id input is rejected (chat image_url has no file_id)", async () => {
    await expect(toChatImagePart({ fileId: "file_123" })).rejects.toBeInstanceOf(UnifiedError);
  });

  test("raw base64 string without mime throws", async () => {
    await expect(toChatImagePart("aGVsbG8=")).rejects.toBeInstanceOf(UnifiedError);
  });
});

describe("toChatAudioPart", () => {
  test("WAV bytes → format wav", async () => {
    const part = await toChatAudioPart(WAV);
    expect(part.type).toBe("input_audio");
    expect(part.input_audio.format).toBe("wav");
    expect(typeof part.input_audio.data).toBe("string");
    expect(part.input_audio.data.length).toBeGreaterThan(0);
  });

  test("MP3 bytes (ID3) → format mp3", async () => {
    const part = await toChatAudioPart(MP3);
    expect(part.input_audio.format).toBe("mp3");
  });

  test("explicit format wins over detection", async () => {
    const part = await toChatAudioPart(WAV, { format: "mp3" });
    expect(part.input_audio.format).toBe("mp3");
  });

  test("URL source is rejected (chat audio is inline-only)", async () => {
    await expect(toChatAudioPart("https://example.com/a.mp3")).rejects.toBeInstanceOf(UnifiedError);
  });

  test("undetectable format with no override throws", async () => {
    // Random bytes that match no audio magic
    await expect(toChatAudioPart(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(
      UnifiedError,
    );
  });
});

describe("toChatVideoPart", () => {
  test("gs:// URL passes through", async () => {
    const part = await toChatVideoPart("gs://bucket/clip.mp4");
    expect(part.video_url.url).toBe("gs://bucket/clip.mp4");
  });

  test("Uint8Array → data URL", async () => {
    const part = await toChatVideoPart(new Uint8Array([1, 2, 3]), { mimeType: "video/mp4" });
    expect(part.video_url.url.startsWith("data:video/mp4;base64,")).toBe(true);
  });

  test("file_id rejected", async () => {
    await expect(toChatVideoPart({ fileId: "file_v" })).rejects.toBeInstanceOf(UnifiedError);
  });
});

describe("toChatFilePart", () => {
  test("PDF bytes → file_data data URL", async () => {
    const part = await toChatFilePart(PDF);
    expect(part.type).toBe("file");
    expect(part.file.file_data?.startsWith("data:application/pdf;base64,")).toBe(true);
  });

  test("http URL → file_url", async () => {
    const part = await toChatFilePart("https://example.com/doc.pdf");
    expect(part.file.file_url).toBe("https://example.com/doc.pdf");
    expect(part.file.file_data).toBeUndefined();
  });

  test("gs:// URL → file_url (not file_data)", async () => {
    // Regression: gs:// was previously misrouted into file_data, sending the
    // bucket URL where the provider expected base64.
    const part = await toChatFilePart("gs://bucket/doc.pdf");
    expect(part.file.file_url).toBe("gs://bucket/doc.pdf");
    expect(part.file.file_data).toBeUndefined();
  });

  test("file_id passes through", async () => {
    const part = await toChatFilePart({ fileId: "file_abc" });
    expect(part.file.file_id).toBe("file_abc");
  });

  test("filename hint preserved", async () => {
    const part = await toChatFilePart(PDF, { filename: "report.pdf" });
    expect(part.file.filename).toBe("report.pdf");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Responses parts
// ────────────────────────────────────────────────────────────────────────────

describe("toResponsesImagePart", () => {
  test("bytes → input_image with image_url data URL", async () => {
    const part = await toResponsesImagePart(PNG);
    expect(part.type).toBe("input_image");
    expect(part.image_url?.startsWith("data:image/png;base64,")).toBe(true);
    expect(part.file_id).toBeUndefined();
  });

  test("file_id input → file_id (no image_url)", async () => {
    const part = await toResponsesImagePart({ fileId: "file_img" });
    expect(part.file_id).toBe("file_img");
    expect(part.image_url).toBeUndefined();
  });
});

describe("toResponsesAudioPart", () => {
  test("delegates to chat audio shape", async () => {
    const part = await toResponsesAudioPart(WAV);
    expect(part.type).toBe("input_audio");
    expect(part.input_audio.format).toBe("wav");
  });
});

describe("toResponsesVideoPart", () => {
  test("file_id path", async () => {
    const part = await toResponsesVideoPart({ fileId: "file_v" });
    expect(part.type).toBe("input_video");
    expect(part.file_id).toBe("file_v");
    expect(part.video_url).toBeUndefined();
    expect(part.file_data).toBeUndefined();
  });

  test("hosted URL path → video_url", async () => {
    const part = await toResponsesVideoPart("https://x/y.mp4");
    expect(part.video_url).toBe("https://x/y.mp4");
    expect(part.file_data).toBeUndefined();
  });

  test("gs:// URL → video_url (not file_data)", async () => {
    const part = await toResponsesVideoPart("gs://b/clip.mp4");
    expect(part.video_url).toBe("gs://b/clip.mp4");
    expect(part.file_data).toBeUndefined();
  });

  test("binary bytes → file_data (not video_url) — /responses input_video " +
    "uses file_data for inline base64", async () => {
    const part = await toResponsesVideoPart(new Uint8Array([1, 2, 3]), {
      mimeType: "video/mp4",
    });
    expect(part.file_data?.startsWith("data:video/mp4;base64,")).toBe(true);
    expect(part.video_url).toBeUndefined();
  });
});

describe("toResponsesFilePart", () => {
  test("bytes → file_data data URL", async () => {
    const part = await toResponsesFilePart(PDF);
    expect(part.type).toBe("input_file");
    expect(part.file_data?.startsWith("data:application/pdf;base64,")).toBe(true);
  });

  test("http URL → file_url", async () => {
    const part = await toResponsesFilePart("https://example.com/d.pdf");
    expect(part.file_url).toBe("https://example.com/d.pdf");
  });

  test("gs:// URL → file_url (not file_data)", async () => {
    const part = await toResponsesFilePart("gs://b/x.pdf");
    expect(part.file_url).toBe("gs://b/x.pdf");
    expect(part.file_data).toBeUndefined();
  });

  test("file_id path", async () => {
    const part = await toResponsesFilePart({ fileId: "file_p" });
    expect(part.file_id).toBe("file_p");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Messages parts (Anthropic)
// ────────────────────────────────────────────────────────────────────────────

describe("toMessagesImagePart", () => {
  test("PNG bytes → base64 source with detected media_type", async () => {
    const part = await toMessagesImagePart(PNG);
    if (part.source.type !== "base64") throw new Error("expected base64 source");
    expect(part.source.media_type).toBe("image/png");
    expect(part.source.data.length).toBeGreaterThan(0);
  });

  test("http URL → url source", async () => {
    const part = await toMessagesImagePart("https://example.com/x.png");
    expect(part.source).toEqual({ type: "url", url: "https://example.com/x.png" });
  });

  test("file_id → file source", async () => {
    const part = await toMessagesImagePart({ fileId: "file_a" });
    expect(part.source).toEqual({ type: "file", file_id: "file_a" });
  });

  test("unsupported media_type rejected", async () => {
    await expect(
      toMessagesImagePart(new Uint8Array([1, 2, 3]), { mimeType: "image/bmp" }),
    ).rejects.toBeInstanceOf(UnifiedError);
  });

  test("data URL → base64 source", async () => {
    const part = await toMessagesImagePart("data:image/png;base64,iVBORw0K");
    if (part.source.type !== "base64") throw new Error("expected base64 source");
    expect(part.source.media_type).toBe("image/png");
    expect(part.source.data).toBe("iVBORw0K");
  });
});

describe("toMessagesDocumentPart", () => {
  test("PDF bytes → base64 application/pdf", async () => {
    const part = await toMessagesDocumentPart(PDF);
    if (part.source.type !== "base64") throw new Error("expected base64 source");
    expect(part.source.media_type).toBe("application/pdf");
  });

  test("non-PDF mime rejected", async () => {
    await expect(toMessagesDocumentPart(PNG)).rejects.toBeInstanceOf(UnifiedError);
  });

  test("URL → url source", async () => {
    const part = await toMessagesDocumentPart("https://example.com/d.pdf");
    expect(part.source).toEqual({ type: "url", url: "https://example.com/d.pdf" });
  });

  test("file_id → file source", async () => {
    const part = await toMessagesDocumentPart({ fileId: "f1" });
    expect(part.source).toEqual({ type: "file", file_id: "f1" });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Helpers facade + cross-runtime sanity
// ────────────────────────────────────────────────────────────────────────────

describe("Mime detection regressions", () => {
  test("MP4 ftyp box → video/mp4", async () => {
    // size...|ftyp|mp42
    const mp4 = new Uint8Array([
      0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0,
    ]);
    const part = await toChatVideoPart(mp4);
    expect(part.video_url.url.startsWith("data:video/mp4;base64,")).toBe(true);
  });

  test("M4A ftyp box → audio/mp4 (not video/mp4)", async () => {
    // size...|ftyp|M4A␣
    const m4a = new Uint8Array([
      0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0,
    ]);
    // Caller can override format; the regression is that detectMime no longer
    // claims video/mp4 for M4A bytes, so this resolves cleanly with explicit format.
    const part = await toChatAudioPart(m4a, { format: "mp3" });
    expect(part.type).toBe("input_audio");
  });

  test("MOV ftyp box → video/quicktime (not video/mp4)", async () => {
    // size...|ftyp|qt␣␣
    const mov = new Uint8Array([
      0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20, 0, 0, 0, 0,
    ]);
    const part = await toChatVideoPart(mov);
    expect(part.video_url.url.startsWith("data:video/quicktime;base64,")).toBe(true);
  });

  test("Bytes with WEBP at offset 8 but no RIFF prefix do not falsely match", async () => {
    const fake = new Uint8Array([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x57, 0x45, 0x42, 0x50, 0xff,
    ]);
    // No magic match → for an image helper this should fail Anthropic strict-mime
    // check rather than silently advertise image/webp.
    await expect(toMessagesImagePart(fake)).rejects.toBeInstanceOf(UnifiedError);
  });

  test("Bytes with WAVE at offset 8 but no RIFF prefix do not falsely match", async () => {
    const fake = new Uint8Array([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x57, 0x41, 0x56, 0x45, 0xff,
    ]);
    // No detected audio format → toChatAudioPart should refuse without explicit format.
    await expect(toChatAudioPart(fake)).rejects.toBeInstanceOf(UnifiedError);
  });
});

describe("Data URL validation", () => {
  test("Non-base64 data URL passed to messages is rejected (not silently corrupted)", async () => {
    // data:image/png,<url-encoded raw> — no ;base64 marker.
    await expect(toMessagesImagePart("data:image/png,%89PNG%0D%0A")).rejects.toBeInstanceOf(
      UnifiedError,
    );
  });

  test("Base64 data URL with explicit ;base64 marker accepted", async () => {
    const part = await toMessagesImagePart("data:image/png;base64,iVBORw0K");
    if (part.source.type !== "base64") throw new Error("expected base64 source");
    expect(part.source.data).toBe("iVBORw0K");
  });
});

describe("Ambiguous-object input rejection", () => {
  test("{ fileId, url } throws (overlapping transports)", async () => {
    await expect(
      toChatFilePart({ fileId: "f", url: "https://x" } as unknown as { fileId: string }),
    ).rejects.toBeInstanceOf(UnifiedError);
  });

  test("{ url, data } throws (overlapping transports)", async () => {
    await expect(
      toChatFilePart({
        url: "https://x",
        data: "AAAA",
        mimeType: "application/pdf",
      } as unknown as { url: string }),
    ).rejects.toBeInstanceOf(UnifiedError);
  });

  test("empty object throws", async () => {
    await expect(toChatFilePart({} as unknown as { fileId: string })).rejects.toBeInstanceOf(
      UnifiedError,
    );
  });
});

describe("Cross-realm Blob (duck-typed)", () => {
  test("object with only arrayBuffer() and type is accepted", async () => {
    // Simulate a cross-realm Blob: not instanceof Blob in this realm, but
    // exposes arrayBuffer() and type.
    const fakeBlob = {
      type: "image/png",
      arrayBuffer: async () => PNG.buffer.slice(0) as ArrayBuffer,
    };
    const part = await toChatImagePart(fakeBlob as unknown as Blob);
    expect(part.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });
});

describe("Large-bytes base64 (btoa fallback)", () => {
  test("encodes 200KB without RangeError when Buffer is hidden", async () => {
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const realBuffer = (globalThis as { Buffer?: unknown }).Buffer;
    try {
      Object.defineProperty(globalThis, "Buffer", { value: undefined, configurable: true });
      const part = await toChatImagePart(big, { mimeType: "image/png" });
      const b64 = part.image_url.url.split(",")[1];
      if (!b64) throw new Error("expected base64 payload");
      // round-trip verification (Buffer restored at this point)
      Object.defineProperty(globalThis, "Buffer", { value: realBuffer, configurable: true });
      const decoded = Uint8Array.from(Buffer.from(b64, "base64"));
      expect(decoded.length).toBe(big.length);
      expect(decoded[0]).toBe(big[0]);
      expect(decoded[big.length - 1]).toBe(big[big.length - 1]);
    } finally {
      Object.defineProperty(globalThis, "Buffer", { value: realBuffer, configurable: true });
    }
  });
});

describe("Helpers facade", () => {
  test("aliases match free functions", async () => {
    const h = new Helpers();
    const a = await h.toImagePart(PNG);
    const b = await toChatImagePart(PNG);
    expect(a).toEqual(b);
  });

  test("prototype methods (no per-instance closures)", () => {
    const a = new Helpers();
    const b = new Helpers();
    expect(a.toImagePart).toBe(b.toImagePart);
  });

  test("base64 round-trip is byte-exact", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    const part = await toChatImagePart(bytes, { mimeType: "image/png" });
    const b64 = part.image_url.url.split(",")[1];
    if (!b64) throw new Error("expected base64 payload");
    // Decode via Buffer (test runs in Bun/Node).
    const round = Uint8Array.from(Buffer.from(b64, "base64"));
    expect(round).toEqual(bytes);
  });

  test("falls back to btoa when Buffer is hidden", async () => {
    const realBuffer = (globalThis as { Buffer?: unknown }).Buffer;
    try {
      // Hide Buffer to force the btoa branch.
      Object.defineProperty(globalThis, "Buffer", { value: undefined, configurable: true });
      const part = await toChatImagePart(PNG);
      expect(part.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "Buffer", { value: realBuffer, configurable: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SDK integration — helpers wire through to a real fetch request body
// ────────────────────────────────────────────────────────────────────────────

describe("SDK integration", () => {
  test("sdk.helpers exists and produces parts that fetch sees verbatim", async () => {
    const { UnifiedAI } = await import("../../src/index");
    let lastBody: unknown;
    const fakeFetch = (async (_: unknown, init: RequestInit) => {
      lastBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          id: "x",
          object: "chat.completion",
          created: 0,
          model: "m",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({ apiUrl: "https://api.test", token: "t", fetch: fakeFetch });
    const imagePart = await sdk.helpers.toImagePart(PNG);
    await sdk.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }, imagePart] }],
    });
    const body = lastBody as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    expect(body.messages[0]?.content[1]?.type).toBe("image_url");
    expect(body.messages[0]?.content[1]?.image_url?.url.startsWith("data:image/png;base64,")).toBe(
      true,
    );
  });
});
