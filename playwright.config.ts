import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  // Bun's `bun test` greedily picks up `*.test.ts` / `*.spec.ts`. Use a
  // distinctive `.pw.ts` suffix so Playwright finds these files and Bun
  // doesn't try to run them.
  testMatch: /.*\.pw\.ts$/,
  // No globalSetup — each spec owns its own fake server lifecycle so failures
  // in one don't leak fixtures into another. Parallelism is fine because each
  // spec listens on port 0 (OS-assigned).
  fullyParallel: false, // serialize so port allocation log lines stay readable
  reporter: process.env.CI ? "github" : "list",
  use: {
    headless: true,
    // Default to Chromium; Webkit/Firefox can be enabled when there's a real
    // engine-specific bug to chase.
    ...devices["Desktop Chrome"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
