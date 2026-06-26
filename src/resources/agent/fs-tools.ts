// The `sdk.fs`-backed tool pack — the "tool spec" half of the agent scaffolding.
//
// These are OpenDesign's unified-agent file tools (write_file / read_file /
// edit_file / list_files), DEFINITIONS verbatim, with the four bodies swapped
// off `node:fs` onto an `sdk.fs` namespace. The path-jail + read-only guard live
// in `sdk.fs`, so these executors stay tiny. Apps opt in by composing the result
// into `RunAgentOptions.tools`; they can subset, wrap, or extend it freely.
import type { FsNamespace } from "../fs/types";
import type { ToolSpec } from "./types";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Build the four file tools bound to `ns` (typically `sdk.fs.namespace()` — the
 * app's own jailed workspace). The model's file operations land in that
 * namespace and nowhere else.
 */
export function fsTools(ns: FsNamespace): ToolSpec[] {
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "write_file",
          description: "Create or overwrite a file in the project directory.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Project-relative file path." },
              content: { type: "string", description: "Full file contents." },
            },
            required: ["path", "content"],
          },
        },
      },
      async execute(input) {
        const path = String(input.path ?? "");
        try {
          await ns.write(path, String(input.content ?? ""));
          return { content: `Wrote ${path}` };
        } catch (e) {
          return { content: errText(e), isError: true };
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file from the project directory.",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Project-relative file path." } },
            required: ["path"],
          },
        },
      },
      async execute(input) {
        try {
          return { content: await ns.read(String(input.path ?? "")) };
        } catch (e) {
          return { content: errText(e), isError: true };
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "edit_file",
          description: "Replace one exact, unique occurrence of a string in a file.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
              old_string: { type: "string" },
              new_string: { type: "string" },
            },
            required: ["path", "old_string", "new_string"],
          },
        },
      },
      async execute(input) {
        const path = String(input.path ?? "");
        try {
          await ns.edit(path, String(input.old_string ?? ""), String(input.new_string ?? ""));
          return { content: `Edited ${path}` };
        } catch (e) {
          return { content: errText(e), isError: true };
        }
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "list_files",
          description: "List files in the project directory.",
          parameters: { type: "object", properties: {} },
        },
      },
      async execute() {
        try {
          const entries = await ns.list();
          return { content: entries.length ? entries.map((e) => e.path).join("\n") : "(empty)" };
        } catch (e) {
          return { content: errText(e), isError: true };
        }
      },
    },
  ];
}
