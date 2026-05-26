// Cleanup helper for integration tests that hit a real Supabase bucket.
//
// Tracks every file_id uploaded during a test run and deletes the
// corresponding storage objects at the end of the suite. Activates only
// when the harness is in RECORD mode AND a test SUPABASE service-role key
// is available — in replay mode this is a no-op (no live state to clean).
//
// Safety:
//   - Bucket name is fixed to `generated-images` (the only one unified-api
//     writes to today).
//   - User-id prefix MUST match a strict regex AND start with
//     `sdk-integration-tests`. `startsWith` alone is not enough — values
//     like `sdk-integration-tests-shared` or `sdk-integration-tests/../foo`
//     would pass that check and escape the intended namespace.

const SAFE_PREFIX = "sdk-integration-tests";
const SAFE_PREFIX_RE = /^sdk-integration-tests(?:-[A-Za-z0-9_-]+)?$/;
const BUCKET = "generated-images";

export interface UploadedArtifact {
  fileId: string;
  /** Extension derived from the upload's mime — needed because storage paths
   *  are `${userId}/uploads/${fileId}.${ext}`, not bare uuids. */
  ext: string;
  /** Signed URL returned by the upload. Used to verify the unified-api
   *  server is writing to the same Supabase host this cleanup helper will
   *  delete from — guards against TEST_SUPABASE_URL / .env.test.local
   *  divergence. */
  imageUrl: string;
}

export class SupabaseCleanup {
  private readonly tracked: UploadedArtifact[] = [];
  private readonly enabled: boolean;
  private readonly supabaseUrl: string;
  private readonly secretKey: string;
  private readonly userIdPrefix: string;
  private readonly expectedHost: string;

  constructor(opts: { record: boolean }) {
    this.supabaseUrl = process.env.TEST_SUPABASE_URL ?? "";
    this.secretKey = process.env.TEST_SUPABASE_SECRET_KEY ?? "";
    // Match unified-api's behavior exactly: unset → fall back to the safe
    // prefix; explicit empty string → fail loudly via the regex below (an
    // empty env var is a misconfiguration, not a default request).
    this.userIdPrefix =
      process.env.BYPASS_AUTH_USER_ID === undefined
        ? SAFE_PREFIX
        : process.env.BYPASS_AUTH_USER_ID;
    // Hostname from TEST_SUPABASE_URL — every uploaded image_url MUST live on
    // this host, otherwise the unified-api server is writing to a different
    // Supabase project than we'd delete from. Empty when supabaseUrl is unset
    // (replay mode); guarded below.
    this.expectedHost = this.supabaseUrl ? new URL(this.supabaseUrl).host : "";

    // Strict charset match — no path separators, no traversal sequences, no
    // suffix that could let a sibling namespace masquerade as the test one.
    if (!SAFE_PREFIX_RE.test(this.userIdPrefix)) {
      throw new Error(
        `SupabaseCleanup refuses to operate with userId prefix "${this.userIdPrefix}" — ` +
          `must match ${SAFE_PREFIX_RE} to scope deletions safely.`,
      );
    }

    this.enabled =
      opts.record && this.supabaseUrl.length > 0 && this.secretKey.length > 0;
  }

  track(fileId: string, ext: string, imageUrl: string): void {
    if (!this.enabled) return;
    // Fail loud if the server is writing to a different Supabase project than
    // we'd delete from. This catches the case where .env.test.local on the
    // server points at one project while the developer's shell exports
    // TEST_SUPABASE_URL pointing at another — without this check, the cleanup
    // DELETE would silently target nonexistent paths and report success.
    let urlHost = "";
    try {
      urlHost = new URL(imageUrl).host;
    } catch {
      // ignore — assertion below handles missing host
    }
    if (urlHost !== this.expectedHost) {
      throw new Error(
        `SupabaseCleanup: server returned image_url on host "${urlHost}" but ` +
          `TEST_SUPABASE_URL is "${this.expectedHost}". The unified-api ` +
          `process and the SDK test process disagree about which Supabase ` +
          `project to use — fix .env.test.local / TEST_SUPABASE_URL so they match.`,
      );
    }
    this.tracked.push({ fileId, ext, imageUrl });
  }

  /** Returns the count of artifacts tracked so far (for assertions). */
  count(): number {
    return this.tracked.length;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async cleanup(): Promise<{ deleted: number; failed: string[] }> {
    if (!this.enabled || this.tracked.length === 0) {
      return { deleted: 0, failed: [] };
    }
    const paths = this.tracked.map(
      ({ fileId, ext }) => `${this.userIdPrefix}/uploads/${fileId}.${ext}`,
    );
    // Belt-and-suspenders: re-verify every path is scoped inside the safe
    // prefix DIRECTORY (with trailing slash) before sending the delete. A bug
    // that constructs a sibling-prefix path (e.g. `sdk-integration-tests-foo/`)
    // is rejected here even if userIdPrefix was somehow mutated.
    const expectedRoot = `${this.userIdPrefix}/`;
    const unsafe = paths.filter((p) => !p.startsWith(expectedRoot));
    if (unsafe.length > 0) {
      throw new Error(
        `SupabaseCleanup aborted: ${unsafe.length} path(s) not under ${expectedRoot}: ${unsafe.join(", ")}`,
      );
    }
    const res = await fetch(
      `${this.supabaseUrl}/storage/v1/object/${BUCKET}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          apikey: this.secretKey,
          "content-type": "application/json",
        },
        // `prefixes` is the field name used by supabase-js's
        // StorageFileApi.remove (entries are treated as exact object paths
        // despite the name, per the Storage API contract).
        body: JSON.stringify({ prefixes: paths }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "<unreadable>");
      return {
        deleted: 0,
        failed: [`${res.status}: ${text.slice(0, 300)}`],
      };
    }
    // Supabase Storage returns an array of removed objects. The `.catch`
    // below means `removed` is always an array — empty if the body was
    // un-parseable, populated with object records on success. Reporting
    // `removed.length` is therefore always honest (0 on mismatch / parse
    // failure), avoiding the misleading optimism of `paths.length`.
    const removed = (await res.json().catch(() => [])) as Array<{ name?: string }>;
    const deleted = Array.isArray(removed) ? removed.length : 0;
    // Surface partial deletes: if the API returned 2xx but removed fewer
    // objects than we submitted, the missing paths almost certainly never
    // existed (server-side upload failure, prefix drift) and would otherwise
    // leak silently. Report them as failures so the afterAll hook's
    // console.warn surfaces the gap.
    const submitted = paths.length;
    const failed: string[] = [];
    if (deleted < submitted) {
      failed.push(
        `submitted=${submitted} but removed=${deleted} — ${submitted - deleted} ` +
          `path(s) were not deleted by Supabase (likely never existed on the bucket; check for upload-time failures or prefix divergence)`,
      );
    }
    this.tracked.length = 0;
    return { deleted, failed };
  }
}
