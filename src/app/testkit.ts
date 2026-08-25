// Test-utility entry for embedded apps — import from
// "@unifiedai/sdk/app/testkit".
//
// Deliberately separate from the "./app" barrel so test helpers never ship in
// a production `search.js` chunk. Everything here is browser-safe.
export * from "./search/testkit";
