// The metadata-merge primitives shared by the CLIENT optimistic path
// (`WorkspaceSync.apply`) and the in-memory `FakeSyncServer`. Kept in ONE place
// so the local optimistic result can never drift from the server's merge — the
// "mirror the server merge in JS exactly" requirement (incl. `null` removing a
// key) is enforced by both sides calling the same function.

/**
 * Shallow-merge `patch` over `base`. A JSON `null` value REMOVES that key (the
 * documented delete-a-field convention); any other value overwrites. `base` is
 * not mutated.
 */
export function mergePatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}
