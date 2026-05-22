// Shared line-buffered stdin reader. Multiple callers across the process
// can call `ask()` and get sequential lines without each closing the
// readline interface (which on a piped stdin causes EOF for everyone).

import { createInterface, type Interface as ReadlineInterface } from "node:readline";

let rl: ReadlineInterface | undefined;
const queue: string[] = [];
const waiters: Array<(s: string) => void> = [];
let closed = false;

function ensure(): void {
  if (rl) return;
  rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", (line) => {
    const w = waiters.shift();
    w ? w(line) : queue.push(line);
  });
  rl.once("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()?.("");
  });
}

export function ask(label: string): Promise<string> {
  ensure();
  process.stdout.write(label);
  if (queue.length > 0) return Promise.resolve(queue.shift() as string);
  if (closed) return Promise.resolve("");
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

export function stdinClosed(): boolean {
  return closed;
}

export function closeStdin(): void {
  rl?.close();
}
