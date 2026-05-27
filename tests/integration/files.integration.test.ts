import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type IntegrationHarness, RECORD, startIntegrationHarness } from "./helpers/sdk-client";
import { SupabaseCleanup } from "./helpers/supabase-cleanup";

const ROUND_TRIP_CASSETTE = join(
  import.meta.dir,
  "cassettes",
  "files",
  "upload-then-responses.json",
);
// In replay mode, only run the round-trip test if its cassette exists. The
// cassette is recorded on demand against the test Supabase project (which is
// publicly reachable so cloud vision models can fetch the signed URL) — see
// `bun run dev:test` in unified-api.
const HAS_ROUND_TRIP_CASSETTE = RECORD || existsSync(ROUND_TRIP_CASSETTE);

// A vision-capable model — needed to verify file_id round-trips through
// responses.create as an input_image. The text-only model in TEST_MODELS
// rejects image input.
const VISION_MODEL = "gemini-3.1-flash-lite-preview";

// Minimal 1x1 transparent PNG.
const PNG_1X1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
  0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

describe("integration: files", () => {
  let h: IntegrationHarness;
  const cleanup = new SupabaseCleanup({ record: RECORD });

  beforeEach(async () => {
    h = await startIntegrationHarness();
  });

  afterEach(async () => {
    if (h) {
      h.flush();
      await h.stop();
    }
  });

  afterAll(async () => {
    const { deleted, failed } = await cleanup.cleanup();
    if (failed.length > 0) {
      console.warn(
        `[files.integration] cleanup partial: deleted=${deleted}, failed=${failed.join(", ")}`,
      );
    }
  });

  test("uploads a Uint8Array and returns a file_id (explicit content-type)", async () => {
    h.cassette("files/upload");

    const res = await h.sdk.files.upload(PNG_1X1, {
      filename: "pixel.png",
      contentType: "image/png",
    });
    cleanup.track(res.file_id, "png", res.image_url);

    expect(typeof res.file_id).toBe("string");
    expect(res.file_id.length).toBeGreaterThan(0);
    expect(typeof res.image_url).toBe("string");
    expect(res.image_url).toMatch(/^https?:\/\//);

    // Replay-server only matches method+path; assert here that the multipart
    // body actually reached it (catches regressions where the SDK silently
    // sends an empty body after a refactor). Only meaningful in replay mode
    // — RECORD mode forwards to upstream and doesn't queue requests locally.
    if (!RECORD) {
      const seen = h.requests();
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]?.method).toBe("POST");
      expect(seen[0]?.path).toBe("/api/v1/images/uploads");
      const body = seen[0]?.body;
      expect(body).toBeDefined();
      expect(body).not.toBeNull();
      expect(typeof body === "string" && body.includes('name="file"')).toBe(true);
    }
  }, 60_000);

  test("uploads raw bytes with no contentType — SDK sniffs the mime", async () => {
    h.cassette("files/upload-sniffed");

    // No filename, no contentType — exercises the magic-byte sniffer end-to-end.
    const res = await h.sdk.files.upload(PNG_1X1);
    cleanup.track(res.file_id, "png", res.image_url);

    expect(typeof res.file_id).toBe("string");
    expect(res.file_id.length).toBeGreaterThan(0);
    expect(res.image_url).toMatch(/^https?:\/\//);
  }, 60_000);

  test("uploads a typed-less Blob — SDK sniffs the mime", async () => {
    h.cassette("files/upload-blob-empty-type");

    // Mimics a clipboard paste / drag-drop Blob with no declared type.
    const blob = new Blob([PNG_1X1]);
    expect(blob.type).toBe("");

    const res = await h.sdk.files.upload(blob);
    cleanup.track(res.file_id, "png", res.image_url);

    expect(typeof res.file_id).toBe("string");
    expect(res.image_url).toMatch(/^https?:\/\//);
  }, 60_000);

  test("uploads from a base64 data URL", async () => {
    h.cassette("files/upload-data-url");

    const b64 = Buffer.from(PNG_1X1).toString("base64");
    const res = await h.sdk.files.upload(`data:image/png;base64,${b64}`);
    cleanup.track(res.file_id, "png", res.image_url);

    expect(typeof res.file_id).toBe("string");
    expect(res.image_url).toMatch(/^https?:\/\//);
  }, 60_000);

  // End-to-end round-trip: upload bytes → reference returned file_id in a
  // responses.create call. This validates that the backend correctly
  // rehydrates `file_id` into bytes the upstream model can decode.
  //
  // Requires Supabase to be reachable from the upstream model (the test
  // project URL is public; the local-dev Supabase at 127.0.0.1:54321 is not).
  // In replay mode the cassette stands in for both calls, so CI doesn't need
  // either Supabase or a live model.
  test.skipIf(!HAS_ROUND_TRIP_CASSETTE)(
    "uploaded image_url is accepted by responses.create as input_image",
    async () => {
      h.cassette("files/upload-then-responses");

      // Only fetch real photo bytes when recording (we need bytes the upstream
      // provider can decode). In replay mode the cassette satisfies both calls
      // without re-uploading anything, so a tiny inline fixture keeps CI off
      // the picsum.photos network dependency.
      let photoBytes: Uint8Array;
      let contentType: string;
      if (RECORD) {
        const fetched = await fetch("https://picsum.photos/seed/uni-sdk-files/256.jpg");
        if (!fetched.ok) {
          throw new Error(
            `picsum.photos returned ${fetched.status} — cannot record round-trip cassette.`,
          );
        }
        const fetchedCt = (fetched.headers.get("content-type") ?? "").toLowerCase();
        if (!fetchedCt.startsWith("image/")) {
          throw new Error(`picsum.photos returned content-type "${fetchedCt}" — expected image/*.`);
        }
        photoBytes = new Uint8Array(await fetched.arrayBuffer());
        contentType = fetchedCt.split(";")[0]?.trim() ?? "image/jpeg";
      } else {
        // Replay: bytes don't reach a real provider; any image-shaped payload
        // works. PNG_1X1 keeps the request structurally similar to the recorded
        // one (multipart with image/png Content-Type, small body).
        photoBytes = PNG_1X1;
        contentType = "image/png";
      }
      // Mirror unified-api's MIME_EXT mapping (imageUpload.ts:9-13). The
      // backend stores files at `${userId}/uploads/${fileId}.${ext}` based on
      // file.type — using the same map here keeps cleanup() targeting the
      // exact path the server wrote.
      const MIME_EXT: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
      };
      const ext = MIME_EXT[contentType];
      if (!ext) {
        throw new Error(
          `unsupported content-type: "${contentType}". ` +
            `Backend only accepts ${Object.keys(MIME_EXT).join(", ")}.`,
        );
      }

      const uploaded = await h.sdk.files.upload(photoBytes, {
        filename: `photo.${ext}`,
        contentType,
      });
      cleanup.track(uploaded.file_id, ext, uploaded.image_url);
      expect(typeof uploaded.file_id).toBe("string");

      // KNOWN BACKEND GAP — unified-api/src/lib/multimodal.ts:437-440 passes
      // `file_id` through to the provider verbatim, assuming OpenAI's
      // `file-...` format. The Supabase-issued UUID we return from upload
      // isn't recognised by Gemini/VertexAI/Anthropic and causes 500 "Failed
      // to decode image data". Until the backend adds a Supabase file_id →
      // signed URL resolution step, the canonical reference downstream is
      // `image_url`, not `file_id`. This still proves the round-trip:
      //   bytes uploaded → publicly-reachable signed URL → provider fetches → decodes
      // which is the whole user-visible contract.
      const res = await h.sdk.responses.create({
        model: VISION_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "Describe this image in one word." },
              { type: "input_image", image_url: uploaded.image_url },
            ],
          },
        ],
      });

      expect(res).toBeDefined();
      expect((res as { id?: string }).id ?? (res as { output?: unknown[] }).output).toBeDefined();
    },
    120_000,
  );

  // ── /api/v1/files endpoints (UNI-88) ─────────────────────────────────────

  test("create posts multipart to /api/v1/files and returns a FileObject", async () => {
    h.cassette("files/create");
    const res = await h.sdk.files.create(PNG_1X1, {
      filename: "doc.pdf",
      contentType: "application/pdf",
      purpose: "user_data",
    });
    // NOTE: SupabaseCleanup was written for the old imageUpload path layout
    // (`${userId}/uploads/...` in the `generated-images` bucket). Files
    // created via `files.create()` live in the `user-files` bucket at
    // `${userId}/${id}.${ext}`, so the helper isn't reused here. In RECORD
    // mode, manually clean test files with `sdk.files.del(id)` after the
    // recording session or extend SupabaseCleanup with a `user-files`-aware
    // path resolver.

    expect(res.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(res.filename).toBe("doc.pdf");
    expect(res.mime_type).toBe("application/pdf");
    expect(res.bytes).toBeGreaterThan(0);
    expect(res.purpose).toBe("user_data");
    expect(res.created_at).toBeDefined();

    if (!RECORD) {
      const seen = h.requests();
      expect(seen[0]?.method).toBe("POST");
      expect(seen[0]?.path).toBe("/api/v1/files");
    }
  }, 60_000);

  test("list returns the user's files newest-first", async () => {
    h.cassette("files/list");
    const res = await h.sdk.files.list();
    expect(Array.isArray(res.data)).toBe(true);
    if (!RECORD) {
      expect(h.requests()[0]?.method).toBe("GET");
      expect(h.requests()[0]?.path).toBe("/api/v1/files");
    }
  }, 60_000);

  // For retrieve / del / content, the test must first upload so the cassette
  // captures the real Supabase-issued UUID. Replay-mode then re-uses the same
  // id end-to-end (the replay server matches method+path and serves
  // interactions in cassette order, so the chained ids align).

  test("retrieve returns metadata for a freshly-created file", async () => {
    h.cassette("files/retrieve");
    const created = await h.sdk.files.create(PNG_1X1, {
      filename: "retrieve.png",
      contentType: "image/png",
    });
    const res = await h.sdk.files.retrieve(created.id);
    expect(res.id).toBe(created.id);
    expect(res.filename).toBe("retrieve.png");
    expect(res.mime_type).toBe("image/png");
    expect(res.bytes).toBe(PNG_1X1.length);
    // Tidy up and extend the cassette with the DELETE interaction so future
    // replays stay consistent.
    await h.sdk.files.del(created.id);
    if (!RECORD) {
      const seen = h.requests();
      expect(seen[0]?.method).toBe("POST");
      expect(seen[0]?.path).toBe("/api/v1/files");
      expect(seen[1]?.method).toBe("GET");
      expect(seen[1]?.path).toBe(`/api/v1/files/${created.id}`);
    }
  }, 60_000);

  test("del returns {id, deleted: true} and uses DELETE", async () => {
    h.cassette("files/delete");
    const created = await h.sdk.files.create(PNG_1X1, {
      filename: "delete.png",
      contentType: "image/png",
    });
    const res = await h.sdk.files.del(created.id);
    expect(res.id).toBe(created.id);
    expect(res.deleted).toBe(true);
    if (!RECORD) {
      const seen = h.requests();
      expect(seen[1]?.method).toBe("DELETE");
      expect(seen[1]?.path).toBe(`/api/v1/files/${created.id}`);
    }
  }, 60_000);

  test("content downloads bytes and parses filename from Content-Disposition", async () => {
    h.cassette("files/content");
    const created = await h.sdk.files.create(PNG_1X1, {
      filename: "content.png",
      contentType: "image/png",
    });
    const res = await h.sdk.files.content(created.id);
    expect(res.contentType).toBe("image/png");
    expect(res.filename).toBe("content.png");
    expect(res.bytes.byteLength).toBe(PNG_1X1.length);
    // Bytes round-trip exactly.
    const roundTripped = new Uint8Array(res.bytes);
    for (let i = 0; i < PNG_1X1.length; i++) {
      expect(roundTripped[i]).toBe(PNG_1X1[i]!);
    }
    await h.sdk.files.del(created.id);
    if (!RECORD) {
      const seen = h.requests();
      expect(seen[1]?.method).toBe("GET");
      expect(seen[1]?.path).toBe(`/api/v1/files/${created.id}/content`);
    }
  }, 60_000);

  test("retrieve throws when id is missing without hitting the network", async () => {
    h.cassette("files/retrieve-empty");
    await expect(h.sdk.files.retrieve("")).rejects.toThrow(/non-empty id/);
    if (!RECORD) {
      // No request should have been made.
      expect(h.requests()).toHaveLength(0);
    }
  });

  test("del throws when id is missing without hitting the network", async () => {
    h.cassette("files/delete-empty");
    await expect(h.sdk.files.del("")).rejects.toThrow(/non-empty id/);
    if (!RECORD) {
      expect(h.requests()).toHaveLength(0);
    }
  });

  // Companion to the test above: explicitly exercise the (currently broken)
  // file_id path so the backend gap stays visible in CI and we get a clear
  // signal when it closes. This test will START FAILING when the backend
  // adds the Supabase file_id → signed URL resolution layer — at which point
  // remove the `.toThrow(...)` wrapper and assert success instead.
  //
  // Gated on its own cassette presence; recording requires the same
  // RECORD=true + cloud-Supabase workflow as the happy-path test above.
  const FILE_ID_CASSETTE = join(
    import.meta.dir,
    "cassettes",
    "files",
    "upload-then-responses-file-id-xfail.json",
  );
  const HAS_FILE_ID_CASSETTE = RECORD || existsSync(FILE_ID_CASSETTE);
  test.skipIf(!HAS_FILE_ID_CASSETTE)(
    "[xfail until backend fix] passing file_id to responses.create surfaces the resolution gap",
    async () => {
      h.cassette("files/upload-then-responses-file-id-xfail");
      const bytes = RECORD
        ? new Uint8Array(
            await (await fetch("https://picsum.photos/seed/uni-sdk-files/256.jpg")).arrayBuffer(),
          )
        : PNG_1X1;
      const ct = RECORD ? "image/jpeg" : "image/png";
      const uploaded = await h.sdk.files.upload(bytes, {
        filename: `xfail.${ct === "image/png" ? "png" : "jpg"}`,
        contentType: ct,
      });
      cleanup.track(uploaded.file_id, ct === "image/png" ? "png" : "jpg", uploaded.image_url);

      await expect(
        h.sdk.responses.create({
          model: VISION_MODEL,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "Describe this image." },
                { type: "input_image", file_id: uploaded.file_id },
              ],
            },
          ],
        }),
      ).rejects.toThrow(/Failed to decode image data|image|invalid/i);
    },
    120_000,
  );
});
