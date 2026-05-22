// Demo app for exercising @unifiedai/sdk during development.
// Bare bones on purpose — extend this as the SDK grows.
//
// Run from repo root:  bun run demo

import { UnifiedAI } from "../../src/index.ts";

async function main(): Promise<void> {
	// TODO: wire up bootstrap / identity / etc. as the SDK exposes them.
	// For now this just proves the import resolves.
	console.log("demo-app: UnifiedAI =", typeof UnifiedAI);
}

void main();
