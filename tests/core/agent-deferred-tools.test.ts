import { describe, expect, test } from "bun:test";
import { type ToolSpec, UnifiedAI } from "../../src/index";

// The agent loop's LIVE `tools` contract (RunAgentOptions.tools): a tool's
// `execute` may push additional ToolSpecs into the SAME array mid-run (deferred
// tool loading — the desktop host's `load_app_tools`), and from the next step on
// those tools must be BOTH advertised in the request AND dispatchable. The
// dispatch half is the fragile one: `toolMap` is rebuilt at the top of every
// step; hoisting it out of the loop makes the model call a tool it was just
// advertised and get back "Unknown tool".

interface RecordedRequest {
  toolNames: string[];
  messages: Array<Record<string, unknown>>;
}

/** One streamed turn, expressed as the SSE frames the gateway would emit. */
type Turn = { text: string } | { toolCalls: Array<{ id: string; name: string; args: string }> };

function sseBody(turn: Turn): string {
  const frames: string[] = [];
  const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "test-model" };
  if ("text" in turn) {
    frames.push(
      JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: turn.text } }] }),
    );
    frames.push(
      JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    );
  } else {
    turn.toolCalls.forEach((tc, index) => {
      frames.push(
        JSON.stringify({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index, id: tc.id, function: { name: tc.name, arguments: tc.args } }],
              },
            },
          ],
        }),
      );
    });
    frames.push(
      JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
    );
  }
  return `${frames.map((f) => `data: ${f}\n\n`).join("")}data: [DONE]\n\n`;
}

/** A gateway that replays a scripted turn per request and records what it was sent. */
function scriptedGateway(turns: Turn[]): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let call = 0;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      tools?: Array<{ function: { name: string } }>;
      messages?: Array<Record<string, unknown>>;
    };
    requests.push({
      toolNames: (body.tools ?? []).map((t) => t.function.name),
      messages: body.messages ?? [],
    });
    const turn = turns[call++];
    if (!turn) throw new Error(`gateway called ${call} times; only ${turns.length} turns scripted`);
    return new Response(sseBody(turn), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, requests };
}

function sdkWith(fetchImpl: typeof fetch): UnifiedAI {
  return new UnifiedAI({ apiUrl: "https://gateway.test", fetch: fetchImpl, token: "t" });
}

function toolSpec(name: string, execute: ToolSpec["execute"]): ToolSpec {
  return {
    definition: {
      type: "function",
      function: { name, description: `${name} tool`, parameters: { type: "object" } },
    },
    execute,
  };
}

/** Every tool_result the run fed back, in dispatch order. */
function toolResults(messages: Array<{ role?: string; content?: unknown }>): string[] {
  return messages.filter((m) => m.role === "tool").map((m) => String(m.content));
}

describe("agent loop: tools appended mid-run (deferred tool loading)", () => {
  test("a tool pushed by another tool's execute is advertised AND dispatchable next step", async () => {
    let bCalls = 0;
    const tools: ToolSpec[] = [];
    // `loader` is the shape the desktop host uses: its execute appends the
    // loaded app's ToolSpecs to the very array `run` was handed.
    tools.push(
      toolSpec("load_app_tools", async () => {
        tools.push(
          toolSpec("sheets__setCells", async () => {
            bCalls++;
            return { content: "wrote 3 cells" };
          }),
        );
        return { content: 'Loaded 1 tool(s) for "sheets": sheets__setCells.' };
      }),
    );

    const { fetch: gw, requests } = scriptedGateway([
      { toolCalls: [{ id: "t1", name: "load_app_tools", args: '{"app":"sheets"}' }] },
      { toolCalls: [{ id: "t2", name: "sheets__setCells", args: '{"a":1}' }] },
      { text: "Done." },
    ]);

    const result = await sdkWith(gw).agent.run({ prompt: "fill the sheet", tools });

    expect(result.ok).toBe(true);
    // The pushed tool actually ran — proves `toolMap` saw the mid-run append.
    expect(bCalls).toBe(1);
    expect(toolResults(result.messages)).toEqual([
      'Loaded 1 tool(s) for "sheets": sheets__setCells.',
      "wrote 3 cells",
    ]);
    expect(toolResults(result.messages).some((c) => c.includes("Unknown tool"))).toBe(false);

    // …and it was advertised on the request that followed the load.
    expect(requests).toHaveLength(3);
    expect(requests[0]?.toolNames).toEqual(["load_app_tools"]);
    expect(requests[1]?.toolNames).toEqual(["load_app_tools", "sheets__setCells"]);
    expect(requests[2]?.toolNames).toEqual(["load_app_tools", "sheets__setCells"]);
  });

  test("the loop still reports Unknown tool for a name that was never loaded", async () => {
    const tools: ToolSpec[] = [toolSpec("load_app_tools", async () => ({ content: "ok" }))];
    const { fetch: gw } = scriptedGateway([
      { toolCalls: [{ id: "t1", name: "sheets__setCells", args: "{}" }] },
      { text: "Sorry." },
    ]);

    const result = await sdkWith(gw).agent.run({ prompt: "fill the sheet", tools });

    expect(result.ok).toBe(true);
    expect(toolResults(result.messages)).toEqual(["Unknown tool: sheets__setCells"]);
  });

  test("tools appended by a PRELOAD-style push before run are advertised on turn one", async () => {
    const tools: ToolSpec[] = [toolSpec("load_app_tools", async () => ({ content: "ok" }))];
    tools.push(toolSpec("design__listDesigns", async () => ({ content: "[]" })));
    const { fetch: gw, requests } = scriptedGateway([{ text: "hi" }]);

    await sdkWith(gw).agent.run({ prompt: "hello", tools });

    expect(requests[0]?.toolNames).toEqual(["load_app_tools", "design__listDesigns"]);
  });

  test("KNOWN LIMITATION: a tool pushed mid-step is not dispatchable in the SAME step", async () => {
    // `toolMap` is snapshotted at the top of each step, so a tool the model
    // calls in the SAME assistant message that called the loader is unknown.
    // Harmless in practice (the model cannot know the tool's name/schema until
    // the loader returns), but pinned here so a change in either direction is
    // a deliberate one.
    let bCalls = 0;
    const tools: ToolSpec[] = [];
    tools.push(
      toolSpec("load_app_tools", async () => {
        tools.push(
          toolSpec("sheets__setCells", async () => {
            bCalls++;
            return { content: "wrote" };
          }),
        );
        return { content: "loaded" };
      }),
    );

    const { fetch: gw } = scriptedGateway([
      {
        toolCalls: [
          { id: "t1", name: "load_app_tools", args: '{"app":"sheets"}' },
          { id: "t2", name: "sheets__setCells", args: "{}" },
        ],
      },
      { text: "Done." },
    ]);

    const result = await sdkWith(gw).agent.run({ prompt: "fill", tools });

    expect(bCalls).toBe(0);
    expect(toolResults(result.messages)).toEqual(["loaded", "Unknown tool: sheets__setCells"]);
  });
});
