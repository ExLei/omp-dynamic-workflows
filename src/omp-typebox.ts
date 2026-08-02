import { hostTypeBox } from "./omp-host.js";
import { isJsonSchemaValueValid } from "./omp-lazy.js";

export interface TSchema extends Record<string, unknown> {
  safeParse?: (value: unknown) => { success: boolean; data?: unknown };
}

interface TypedSchema<T> extends TSchema {
  readonly static: T;
}

interface TOptional<T> extends TypedSchema<T | undefined> {
  readonly optionalStatic: true;
}

type SchemaRecord = Record<string, TSchema>;
type OptionalKeys<P extends SchemaRecord> = {
  [K in keyof P]: P[K] extends TOptional<unknown> ? K : never;
}[keyof P];
type RequiredKeys<P extends SchemaRecord> = Exclude<keyof P, OptionalKeys<P>>;
type ObjectStatic<P extends SchemaRecord> = {
  [K in RequiredKeys<P>]: Static<P[K]>;
} & {
  [K in OptionalKeys<P>]?: Exclude<Static<P[K]>, undefined>;
};

export type Static<T extends TSchema> = T extends { readonly static: infer U } ? U : unknown;

type SchemaOptions = Record<string, unknown>;

/**
 * Typed facade over OMP's injected Zod-backed TypeBox compatibility runtime.
 *
 * `hostTypeBox()` is read per call rather than captured at module scope: the
 * shim arrives with the ExtensionAPI, which is only available once the
 * extension factory has run.
 */
export const Type = {
  String: (options?: SchemaOptions) => hostTypeBox().Type.String(options) as unknown as TypedSchema<string>,
  Number: (options?: SchemaOptions) => hostTypeBox().Type.Number(options) as unknown as TypedSchema<number>,
  Boolean: (options?: SchemaOptions) => hostTypeBox().Type.Boolean(options) as unknown as TypedSchema<boolean>,
  Any: (options?: SchemaOptions) => hostTypeBox().Type.Any(options) as unknown as TypedSchema<unknown>,
  Literal: <T extends string | number | boolean>(value: T, options?: SchemaOptions) =>
    hostTypeBox().Type.Literal(value, options) as unknown as TypedSchema<T>,
  Optional: <T extends TSchema>(schema: T) =>
    hostTypeBox().Type.Optional(schema as never) as unknown as TOptional<Static<T>>,
  Array: <T extends TSchema>(schema: T, options?: SchemaOptions) =>
    hostTypeBox().Type.Array(schema as never, options) as unknown as TypedSchema<Array<Static<T>>>,
  Union: <T extends readonly TSchema[]>(schemas: T, options?: SchemaOptions) =>
    hostTypeBox().Type.Union(schemas as never, options) as unknown as TypedSchema<Static<T[number]>>,
  Object: <P extends SchemaRecord>(properties: P, options?: SchemaOptions) =>
    hostTypeBox().Type.Object(properties as never, options) as unknown as TypedSchema<ObjectStatic<P>>,
  Unsafe: <T>(schema: Record<string, unknown>) =>
    hostTypeBox().Type.Unsafe<T>(schema) as unknown as TypedSchema<T>,
};

/**
 * Validate `value` against `schema`. Schemas minted by `Type` carry `safeParse`;
 * anything else falls back to the host JSON-Schema validator, which callers must
 * have warmed via `warmSchemaValidator()`.
 */
export function Check(schema: TSchema, value: unknown): boolean {
  return schema.safeParse?.(value).success ?? isJsonSchemaValueValid(schema, value);
}

/**
 * JSON-Schema-guided coercion, mirroring TypeBox's `Value.Convert` over the
 * subset of JSON Schema this shim emits. OMP's TypeBox-compat validators are
 * strict — they never coerce — so without this a prose-extracted `{"n":"7"}`
 * can never satisfy `Type.Number()` and `extractValidated` degenerates into a
 * plain `Check`. Purely best-effort and additive: anything not convertible is
 * returned untouched, and the caller still gates on `Check`.
 */
export function Convert(schema: TSchema, value: unknown): unknown {
  return convertNode(schema, value);
}

const NUMERIC_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function convertNode(node: unknown, value: unknown): unknown {
  if (node === null || typeof node !== "object") return value;
  const schema = node as Record<string, unknown>;

  if ("const" in schema) return convertLiteral(schema.const, value);
  if (Array.isArray(schema.enum)) {
    for (const candidate of schema.enum) {
      const converted = convertLiteral(candidate, value);
      if (converted !== value) return converted;
    }
    return value;
  }

  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches)) return convertBranches(branches, value);

  const type = schema.type;
  if (Array.isArray(type)) return convertBranches(type.map((t) => ({ ...schema, type: t })), value);

  switch (type) {
    case "number":
      return convertNumber(value, false);
    case "integer":
      return convertNumber(value, true);
    case "string":
      return convertString(value);
    case "boolean":
      return convertBoolean(value);
    case "null":
      return value === "null" || value === "" ? null : value;
    case "array":
      return convertArray(schema, value);
    case "object":
      return convertObject(schema, value);
    default:
      return value;
  }
}

/** First branch that both converts and then validates wins; else the input is left alone. */
function convertBranches(branches: readonly unknown[], value: unknown): unknown {
  for (const branch of branches) {
    const converted = convertNode(branch, value);
    if (isJsonSchemaValueValid(branch, converted)) return converted;
  }
  return value;
}

function convertLiteral(literal: unknown, value: unknown): unknown {
  if (value === literal) return value;
  const primitive = typeof literal;
  if (primitive !== "string" && primitive !== "number" && primitive !== "boolean") return value;
  return String(value) === String(literal) ? literal : value;
}

function convertNumber(value: unknown, integer: boolean): unknown {
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "boolean") parsed = value ? 1 : 0;
  else if (typeof value === "string" && NUMERIC_TEXT.test(value.trim())) parsed = Number(value.trim());
  else return value;
  if (Number.isNaN(parsed)) return value;
  return integer ? Math.trunc(parsed) : parsed;
}

function convertString(value: unknown): unknown {
  const primitive = typeof value;
  if (primitive === "number" || primitive === "boolean" || primitive === "bigint") return String(value);
  return value;
}

function convertBoolean(value: unknown): unknown {
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : value;
  if (typeof value !== "string") return value;
  const text = value.trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return value;
}

function convertArray(schema: Record<string, unknown>, value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const prefix = schema.prefixItems;
  if (Array.isArray(prefix)) {
    return value.map((entry, i) => (i < prefix.length ? convertNode(prefix[i], entry) : entry));
  }
  const items = schema.items;
  if (items === undefined) return value;
  return value.map((entry) => convertNode(items, entry));
}

function convertObject(schema: Record<string, unknown>, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const additional = schema.additionalProperties;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const propertySchema = Object.hasOwn(properties, key) ? properties[key] : additional;
    result[key] = propertySchema === undefined ? entry : convertNode(propertySchema, entry);
  }
  return result;
}
