import { describe, expect, test } from "bun:test";
import { extractValidated } from "../src/agent.js";
import { Check, Convert, type TSchema, Type } from "../src/omp-typebox.js";

describe("Convert", () => {
  test("coerces numeric strings so a near-miss object then validates", () => {
    const schema = Type.Object({ n: Type.Number() });
    expect(Check(schema, { n: "7" })).toBe(false);
    const converted = Convert(schema, { n: "7" });
    expect(converted).toEqual({ n: 7 });
    expect(Check(schema, converted)).toBe(true);
  });

  test("coerces booleans and stringly numbers in one pass", () => {
    const schema = Type.Object({
      count: Type.Number(),
      ok: Type.Boolean(),
      label: Type.String(),
    });
    const converted = Convert(schema, { count: "4", ok: "TRUE", label: 12 });
    expect(converted).toEqual({ count: 4, ok: true, label: "12" });
    expect(Check(schema, converted)).toBe(true);
  });

  test("truncates toward zero for integer schemas", () => {
    const raw = { type: "integer" } as unknown as TSchema;
    expect(Convert(raw, "4.9")).toBe(4);
    expect(Convert(raw, "-4.9")).toBe(-4);
  });

  test("recurses through arrays and nested objects", () => {
    const schema = Type.Object({
      rows: Type.Array(Type.Object({ score: Type.Number() })),
    });
    const converted = Convert(schema, { rows: [{ score: "1" }, { score: "2.5" }] });
    expect(converted).toEqual({ rows: [{ score: 1 }, { score: 2.5 }] });
    expect(Check(schema, converted)).toBe(true);
  });

  test("picks the union branch that validates after conversion", () => {
    const schema = Type.Object({ v: Type.Union([Type.Number(), Type.Boolean()]) });
    expect(Check(schema, Convert(schema, { v: "12" }))).toBe(true);
    expect(Convert(schema, { v: "12" })).toEqual({ v: 12 });
    expect(Convert(schema, { v: "false" })).toEqual({ v: false });
  });

  test("leaves unconvertible and already-valid values untouched", () => {
    const schema = Type.Object({ n: Type.Number() });
    expect(Convert(schema, { n: "abc" })).toEqual({ n: "abc" });
    expect(Check(schema, Convert(schema, { n: "abc" }))).toBe(false);
    expect(Convert(schema, { n: 3 })).toEqual({ n: 3 });
    // Unknown extra keys survive; conversion never drops data.
    expect(Convert(schema, { n: "3", extra: "keep" })).toEqual({ n: 3, extra: "keep" });
  });

  test("tolerates schemas with no safeParse metadata", () => {
    const raw = { type: "object", properties: { n: { type: "number" } } } as unknown as TSchema;
    expect(Convert(raw, { n: "9" })).toEqual({ n: 9 });
  });
});

describe("extractValidated", () => {
  test("recovers a fenced JSON block whose scalars need coercion", () => {
    const schema = Type.Object({ verdict: Type.String(), score: Type.Number() });
    const text = 'Here you go:\n```json\n{"verdict":"pass","score":"8"}\n```\n';
    expect(extractValidated<{ verdict: string; score: number }>(text, schema)).toEqual({
      verdict: "pass",
      score: 8,
    });
  });

  test("still refuses prose that cannot satisfy the schema", () => {
    const schema = Type.Object({ verdict: Type.String(), score: Type.Number() });
    expect(extractValidated('{"verdict":"pass","score":"n/a"}', schema)).toBeUndefined();
    expect(extractValidated("no json here", schema)).toBeUndefined();
  });
});
