import { describe, expect, test } from "bun:test";
import { extractValidated } from "../src/agent.js";
import { normalizeSettings } from "../src/workflow-settings.js";
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

describe("normalizeSettings", () => {
  test("coerces syncHostTools / mcpServers / enableIrc, trimming whitespace-only entries", () => {
    // " " 能通过旧版 s.length > 0 过滤，纯空白串必须被 trim 过滤且存值前 trim。
    expect(normalizeSettings({ syncHostTools: false, mcpServers: ["a", 3, " "], enableIrc: true })).toEqual({
      syncHostTools: false,
      mcpServers: ["a"],
      enableIrc: true,
    });
  });

  test("keeps syncHostTools / mcpServers / enableIrc sparse when omitted", () => {
    // 缺省即省略：不物化缺省键，否则项目覆盖文件会经 { ...global, ...project }
    // merge 静默覆盖全局显式设置。缺省语义由消费端（任务 4）?? 兜底。
    const normalized = normalizeSettings({});
    expect(normalized.syncHostTools).toBeUndefined();
    expect(normalized.mcpServers).toBeUndefined();
    expect(normalized.enableIrc).toBeUndefined();
  });

  test("does not materialize defaults for type-invalid values", () => {
    const normalized = normalizeSettings({ syncHostTools: 1, mcpServers: "x", enableIrc: "yes" });
    expect(normalized.syncHostTools).toBeUndefined();
    expect(normalized.mcpServers).toBeUndefined();
    expect(normalized.enableIrc).toBeUndefined();
  });

  test("syncMode: explicit valid values are kept, invalid/absent ones stay sparse", () => {
    // 仅显式合法值输出键；非法值/缺省不物化 auto 缺省键（同三字段不变量，
    // auto 语义由 workflow-tool.ts backgroundDefault ?? 兜底）。
    expect(normalizeSettings({ syncMode: "auto" })).toEqual({ syncMode: "auto" });
    expect(normalizeSettings({ syncMode: "always" })).toEqual({ syncMode: "always" });
    expect(normalizeSettings({ syncMode: "never" })).toEqual({ syncMode: "never" });
    expect(normalizeSettings({ syncMode: "sometimes" })).toEqual({});
    expect(normalizeSettings({ syncMode: 1 })).toEqual({});
    expect(normalizeSettings({}).syncMode).toBeUndefined();
  });
});
