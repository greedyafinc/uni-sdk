// Test-utility entry — import from "@unifiedai/sdk/testing".
//
// Deliberately separate from the main browser/node entries so test doubles
// never ship in production bundles. Everything here is browser-safe.
export { FakeSyncServer } from "../resources/sync/fake-server";
export type { FakeSyncServerOptions } from "../resources/sync/fake-server";
