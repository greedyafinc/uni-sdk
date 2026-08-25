// Type-level regression test for `PredicateOps<V>.match`.
//
// `match?: V extends string ? string : never` looks right for a REQUIRED
// string field, but `V` is a naked type parameter, so TypeScript distributes
// the conditional over `V`'s union members. For an OPTIONAL field — exactly
// the natural shape for `searchText`, the one field `match` targets — `V` is
// `string | undefined`; the `undefined` branch resolves to `never`, and (via
// how `Predicate<T[K]>` is instantiated through the `where` mapped type,
// where `T[K]` is an indexed access rather than a bare type parameter) the
// whole thing collapsed to `never`, making `match` unusable. A caller had to
// write `as unknown as Partial<Row>` just to get `match` to compile.
//
// Fixed by checking `NonNullable<V> extends string` instead, so the
// conditional is evaluated against a plain `string` regardless of whether the
// field's declared type also includes `| undefined` / `| null`.
//
// This file has no runtime behavior to assert — every check below is a
// compile-time constraint. It still runs as an ordinary `bun test` file so a
// regression fails CI the same way any other test would (a `// @ts-expect-error`
// that stops being needed is itself a type error, and `Expect<...>` fails to
// typecheck if the equality doesn't hold).
import { describe, expect, test } from "bun:test";
import type { PredicateOps } from "../../src/resources/storage";

/** Dependency-free type-equality check (the standard tsd/type-fest idiom) —
 * unlike a two-way `extends` check, this distinguishes `string` from
 * `string | undefined`, which is exactly the distinction this bug hinges on. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;

describe("PredicateOps<V>.match — type-level", () => {
  test("match is available for a required string field", () => {
    type _Shape = Expect<Equal<PredicateOps<string>["match"], string | undefined>>;
    const ok: PredicateOps<string> = { match: "hello" };
    expect(ok.match).toBe("hello");
  });

  test("match is available for an OPTIONAL string field (the reported bug)", () => {
    type _Shape = Expect<Equal<PredicateOps<string | undefined>["match"], string | undefined>>;
    const ok: PredicateOps<string | undefined> = { match: "hello" };
    expect(ok.match).toBe("hello");
  });

  test("match is available for a NULLABLE string field", () => {
    type _Shape = Expect<Equal<PredicateOps<string | null>["match"], string | undefined>>;
    const ok: PredicateOps<string | null> = { match: "hello" };
    expect(ok.match).toBe("hello");
  });

  test("match is still rejected for non-string fields", () => {
    // @ts-expect-error — `match` must not be assignable on a `number` field.
    const bad1: PredicateOps<number> = { match: "hello" };
    // @ts-expect-error — nor a `boolean` field.
    const bad2: PredicateOps<boolean> = { match: "hello" };
    // @ts-expect-error — nor an optional/nullable non-string field.
    const bad3: PredicateOps<number | undefined> = { match: "hello" };
    expect([bad1, bad2, bad3]).toBeDefined();
  });
});
