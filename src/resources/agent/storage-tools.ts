// The `sdk.storage`-backed tool pack — generic collection CRUD bound to a
// namespace handle. Domain-agnostic: the app chooses the namespace (and
// therefore the grant) and optionally a collection allowlist. Compose into
// `sdk.agent.run({ tools })` the same way as `fsTools()`.
import type { Namespace } from "../storage/types";
import type { ToolSpec } from "./types";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface StorageToolsOptions {
  /**
   * Collection names the model may touch. Omit to allow any name (the
   * namespace grant still applies). Planner (and any other app) passes its
   * own collection list — the SDK never hard-codes them.
   */
  collections?: readonly string[];
  /** When false (default), omit `storage_put` / `storage_delete`. */
  write?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

/**
 * Build storage tools bound to `ns` (typically `sdk.storage.namespace()` or
 * `sdk.storage.namespace("other-app")` after a grant). Records are opaque
 * JSON objects — the producing app owns the schema.
 */
export function storageTools(ns: Namespace, opts: StorageToolsOptions = {}): ToolSpec[] {
  const allowed = opts.collections ? new Set(opts.collections) : null;
  const write = opts.write === true;

  const collection = (name: string) => {
    if (allowed && !allowed.has(name)) {
      throw new Error(`collection "${name}" is not in the tool allowlist`);
    }
    return ns.collection<Record<string, unknown>>(name, { key: "id" });
  };

  const tools: ToolSpec[] = [
    {
      definition: {
        type: "function",
        function: {
          name: "storage_get",
          description: "Get one record by collection and id from the bound namespace.",
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
      async execute(input) {
        try {
          const rec = await collection(String(input.collection ?? "")).get(String(input.id ?? ""));
          return { content: rec ? JSON.stringify(rec) : "null" };
        } catch (e) {
          return { content: errText(e), isError: true };
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "storage_query",
          description: "List records in a collection. Optional equality `where` object.",
          parameters: {
            type: "object",
            properties: {
              collection: { type: "string" },
              where: { type: "object", additionalProperties: true },
              limit: { type: "number" },
            },
            required: ["collection"],
          },
        },
      },
      async execute(input) {
        try {
          const where =
            input.where && typeof input.where === "object"
              ? (input.where as Record<string, unknown>)
              : undefined;
          const limit = typeof input.limit === "number" ? input.limit : undefined;
          const rows = await collection(String(input.collection ?? "")).query({
            ...(where ? { where } : {}),
            ...(limit !== undefined ? { limit } : {}),
          });
          return { content: JSON.stringify(rows) };
        } catch (e) {
          return { content: errText(e), isError: true };
        }
      },
    },
  ];

  if (write) {
    tools.push(
      {
        definition: {
          type: "function",
          function: {
            name: "storage_put",
            description: "Insert or replace a record. `record` must include an `id` string key.",
            parameters: {
              type: "object",
              properties: {
                collection: { type: "string" },
                record: { type: "object", additionalProperties: true },
              },
              required: ["collection", "record"],
            },
          },
        },
        async execute(input) {
          try {
            const record = asRecord(input.record);
            if (!record.id) {
              return { content: "record.id is required", isError: true };
            }
            const ref = await collection(String(input.collection ?? "")).put(record);
            return { content: JSON.stringify(ref) };
          } catch (e) {
            return { content: errText(e), isError: true };
          }
        },
      },
      {
        definition: {
          type: "function",
          function: {
            name: "storage_delete",
            description: "Delete a record by collection and id.",
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
        async execute(input) {
          try {
            const deleted = await collection(String(input.collection ?? "")).delete(
              String(input.id ?? ""),
            );
            return { content: deleted ? "deleted" : "not found" };
          } catch (e) {
            return { content: errText(e), isError: true };
          }
        },
      },
    );
  }

  return tools;
}
