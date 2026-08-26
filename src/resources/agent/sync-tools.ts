// The `sdk.sync`-backed tool pack — generic read/apply over one namespace
// inside a WorkspaceSync. Domain-agnostic: the app chooses `ns` (e.g.
// `"planner"`) and an optional collection allowlist. Compose into
// `sdk.agent.run({ tools })`.
import type { SyncOp, WorkspaceSync } from "../sync";
import type { ToolSpec } from "./types";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface SyncToolsOptions {
  /** Collection names the model may touch. Omit to allow any name in `ns`. */
  collections?: readonly string[];
  /** When false (default), omit `sync_apply`. */
  write?: boolean;
}

/**
 * Build sync tools bound to one `(workspace, ns)`. Records are opaque
 * metadata bags — the producing app owns the schema.
 */
export function syncTools(ws: WorkspaceSync, ns: string, opts: SyncToolsOptions = {}): ToolSpec[] {
  const allowed = opts.collections ? new Set(opts.collections) : null;
  const write = opts.write === true;

  const check = (collection: string) => {
    if (allowed && !allowed.has(collection)) {
      throw new Error(`collection "${collection}" is not in the tool allowlist`);
    }
  };

  const tools: ToolSpec[] = [
    {
      definition: {
        type: "function",
        function: {
          name: "sync_get",
          description: "Get one live sync record by collection and id.",
          parameters: {
            type: "object",
            properties: {
              collection: { type: "string" },
              id: { type: "string" },
            },
            required: ["collection", "id"],
          },
        },
      },
      execute(input) {
        try {
          const collection = String(input.collection ?? "");
          check(collection);
          const rec = ws.collection(ns, collection).get(String(input.id ?? ""));
          return { content: rec ? JSON.stringify(rec.metadata) : "null" };
        } catch (e) {
          return { content: errText(e), isError: true };
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "sync_list",
          description: "List live records in a collection. Optional equality `where` object.",
          parameters: {
            type: "object",
            properties: {
              collection: { type: "string" },
              where: { type: "object", additionalProperties: true },
            },
            required: ["collection"],
          },
        },
      },
      execute(input) {
        try {
          const collection = String(input.collection ?? "");
          check(collection);
          const where =
            input.where && typeof input.where === "object"
              ? (input.where as Record<string, unknown>)
              : undefined;
          const rows = ws
            .collection(ns, collection)
            .list(where ? { where } : undefined)
            .map((r) => ({ id: r.id, ...r.metadata }));
          return { content: JSON.stringify(rows) };
        } catch (e) {
          return { content: errText(e), isError: true };
        }
      },
    },
  ];

  if (write) {
    tools.push({
      definition: {
        type: "function",
        function: {
          name: "sync_apply",
          description:
            "Apply one mutation: pass exactly one of patch, replace (object), or delete (true).",
          parameters: {
            type: "object",
            properties: {
              collection: { type: "string" },
              id: { type: "string" },
              patch: { type: "object", additionalProperties: true },
              replace: { type: "object", additionalProperties: true },
              delete: { type: "boolean" },
            },
            required: ["collection", "id"],
          },
        },
      },
      async execute(input) {
        try {
          const collection = String(input.collection ?? "");
          check(collection);
          const op: SyncOp = {
            ns,
            collection,
            id: String(input.id ?? ""),
          };
          if (input.delete === true) op.delete = true;
          else if (input.replace && typeof input.replace === "object") {
            op.replace = input.replace as Record<string, unknown>;
          } else if (input.patch && typeof input.patch === "object") {
            op.patch = input.patch as Record<string, unknown>;
          } else {
            return {
              content: "exactly one of patch, replace, or delete is required",
              isError: true,
            };
          }
          const results = await ws.apply([op]);
          return { content: JSON.stringify(results[0] ?? null) };
        } catch (e) {
          return { content: errText(e), isError: true };
        }
      },
    });
  }

  return tools;
}
