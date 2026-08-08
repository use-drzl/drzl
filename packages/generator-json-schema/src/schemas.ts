/**
 * A JSON Schema per table per mode, as data.
 *
 * What JSON Schema cannot say is stated plainly rather than approximated. A comparison between two
 * columns has no expression in the format at all, so it is carried as a `description` and nothing
 * pretends to enforce it.
 *
 * Split out of `index.ts` so `openapi.ts` can build a document from these without the two importing
 * each other. Nothing here changed in the move except the two keywords named on `openapi-3.0`.
 */
import type { Column, Enum, Table } from '@drzl/analyzer';
import type {
  CardinalityCheck,
  ColumnCheck,
  ColumnSet,
  LengthCheck,
  RowCheck,
} from '@drzl/validation-core';
import {
  applyWirePolicy,
  canonicalMembers,
  comparisonWire,
  COLUMN_FORMATS,
  insertColumns,
  isIntegerColumn,
  parseCheck,
  selectColumns,
  updateColumns,
} from '@drzl/validation-core';
import { planSharedEnums, type EnumPlan, type EnumRefResolver } from './enums.js';

export type Mode = 'insert' | 'update' | 'select';

/** A JSON Schema, as data. Deliberately loose: the output is checked by a validator, not by TS. */
export type Schema = Record<string, unknown>;

/**
 * Which spelling of JSON Schema to emit.
 *
 * `draft-2020-12` is the current draft and the default. `openapi-3.1` is that same draft with the
 * `$schema` key left off, which is how a schema appears inside an OpenAPI 3.1 document.
 *
 * `openapi-3.0` predates it and is not a superset: it spells a nullable type as `nullable: true`
 * rather than a type array, an exclusive bound as a boolean flag beside the bound rather than as
 * its own keyword, has no `prefixItems`, no `const`, and no `contentEncoding`. Emitting 2020-12
 * into a 3.0 document produces a document that means something else and, for the last two, one that
 * a validator refuses outright: 3.0's Schema Object is closed, so a keyword from a later draft is an
 * error there rather than something a reader ignores.
 */
export type JsonSchemaTarget = 'draft-2020-12' | 'openapi-3.1' | 'openapi-3.0';

export const DRAFT = 'https://json-schema.org/draft/2020-12/schema';

/** A uuid, as `format`. Unlike TypeBox, JSON Schema validators know this one without setup. */
const UUID_FORMAT = 'uuid';

/**
 * Base64 bytes, in whichever way the target spells them.
 *
 * `contentEncoding` is the 2020-12 keyword and it is an annotation there rather than an assertion:
 * a conforming validator records that the string is meant to be base64 and does not check it.
 * OpenAPI 3.0 has no such keyword at all, and its `format: byte` says the same thing, so a 3.0
 * document gets that instead. Emitting `contentEncoding` into one made the whole document invalid,
 * measured against the official 3.0 schema.
 */
const base64 = (target: JsonSchemaTarget): Schema =>
  target === 'openapi-3.0'
    ? { type: 'string', format: 'byte' }
    : { type: 'string', contentEncoding: 'base64' };

/**
 * A set of numeric-wire members as the pattern accepting exactly their spellings.
 *
 * One alternation branch per canonical member. A member `1.5` admits an optional plus sign,
 * leading integer zeros and trailing fraction zeros ('1.5', '01.50', '+1.500'); a whole member
 * admits the same plus an optional all-zero fraction and a bare trailing dot ('1', '1.', '1.0');
 * zero additionally admits either sign, because the database has no negative zero ('-0.00' came
 * back '0.00', measured). The sign of a nonzero member is fixed: '-1' has no positive spelling.
 *
 * `integerOnly` is the bigint string wire, where the fraction forms are left off: '1.0' is not
 * valid bigint input to Postgres ("invalid input syntax", measured), so admitting it would
 * accept a write the database refuses for no returned row it could ever match.
 *
 * The values arrive canonicalised by the wire policy; `canonicalMembers` here is idempotent and
 * also dedupes members that name one value.
 */
function canonicalSetPattern(values: string[], integerOnly: boolean): string {
  const branches = canonicalMembers(values).map((member) => {
    if (member === '0') return integerOnly ? '[+-]?0+' : '[+-]?(?:0+(?:\\.0*)?|0*\\.0+)';
    const sign = member.startsWith('-') ? '-' : '\\+?';
    const body = member.startsWith('-') ? member.slice(1) : member;
    const [int = '', frac = ''] = body.split('.');
    if (integerOnly) return `${sign}0*${int}`;
    if (!frac) return `${sign}0*${int}(?:\\.0*)?`;
    // A zero integer part may be spelled as no integer part at all: '.5' is '0.5'.
    return int === '0' ? `${sign}0*\\.${frac}0*` : `${sign}0*${int}\\.${frac}0*`;
  });
  return `^(?:${branches.join('|')})$`;
}

/**
 * The JSON Schema for one column, before nullability and defaults are applied.
 *
 * Every branch answers the same question: what does this value look like once it has been through
 * `JSON.stringify`? That is not always what the TypeScript type says. A `bigint` cannot be
 * serialised at all, so it travels as a string; a `Buffer` travels as base64.
 */
function baseSchema(
  c: Column,
  mode: Mode,
  target: JsonSchemaTarget,
  checks: ColumnCheck[],
  sets: ColumnSet[],
  lengths: LengthCheck[],
  enumRef?: EnumRefResolver
): Schema {
  const s = c.shape;
  if (s) {
    switch (s.kind) {
      case 'json':
        // Any JSON value. An empty schema is how the format spells "no constraint", and it is
        // honest: a json column really does accept anything JSON can express.
        return {};
      case 'custom':
        // Nothing is known about a custom type's runtime shape, so nothing is claimed.
        return {};
      case 'buffer': {
        // Binary cannot travel as JSON. Both spellings say how it did.
        const bin = base64(target);
        // `CHECK (octet_length(blob) <= n)` is the one clause a binary column takes, and the
        // measurement it asks for is the plain byte count. See `applyBinaryLengths`.
        applyBinaryLengths(bin, c, lengths);
        return bin;
      }
      case 'tuple':
        // `prefixItems` is 2020-12. OpenAPI 3.0 has no positional form at all, so it falls back
        // to a homogeneous array of the right length, which is the closest true statement.
        return target === 'openapi-3.0'
          ? { type: 'array', items: { type: 'number' }, minItems: s.length, maxItems: s.length }
          : {
              type: 'array',
              prefixItems: Array.from({ length: s.length }, () => ({ type: 'number' })),
              minItems: s.length,
              maxItems: s.length,
            };
      case 'numberObject':
        // The object modes of the same columns: `point({ mode: 'xy' })` returns `{ x, y }` and
        // `line({ mode: 'abc' })` returns `{ a, b, c }`. One spelling for every target, since
        // `type: 'object'`, `properties` and `required` mean the same thing in all three.
        //
        // No `additionalProperties: false`. The column ignores an unlisted key: measured on PGlite
        // through drizzle 0.45.2, `{ x: 1, y: 2, z: 3 }` inserts and the row stores `(1,2)`.
        return {
          type: 'object',
          properties: Object.fromEntries(s.fields.map((f) => [f, { type: 'number' }])),
          required: [...s.fields],
        };
      case 'numberVector':
        return {
          type: 'array',
          items: { type: 'number' },
          ...(s.length ? { minItems: s.length, maxItems: s.length } : {}),
        };
      case 'bitstring':
        return {
          type: 'string',
          pattern: '^[01]*$',
          ...(s.length
            ? s.exact
              ? { minLength: s.length, maxLength: s.length }
              : { maxLength: s.length }
            : {}),
        };
      case 'byteString':
        // A MySQL/SingleStore `binary(n)`/`varbinary(n)`: any bytes at all, handed back as a
        // string, so no pattern. `maxLength` counts code points, which is exactly what the column
        // can return: a lossy decode of n bytes yields at most n of them, measured.
        //
        // The insert side is a byte budget and JSON Schema has no keyword that counts bytes, so
        // the same code-point cap is emitted in every mode. It is a necessary condition there
        // rather than the whole one, since every value the server accepts is at most n bytes and
        // therefore at most n code points; it turns away no valid write, and lets through a value
        // like three emoji that a varbinary(8) refuses. That incompleteness is the same one this
        // generator already carries for MySQL's TEXT byte budget, which it cannot state at all.
        return { type: 'string', ...(s.length ? { maxLength: s.length } : {}) };
    }
  }

  // `CHECK (status IN ('a', 'b'))` is exactly what `enum` means.
  //
  // A number-kind member follows the column's wire: a bigint column is a *string* in a JSON
  // document, per the digits-string policy on the `bigint` arm below, so its members stay the
  // digit strings a serialised row can actually hold. `{ enum: [1, 2] }` there refused every row,
  // and `Number(v)` also rounds a 64 bit member the moment it becomes a number.
  const set = sets.find((x) => x.column === c.name);
  if (set) {
    // On a numeric string wire no enum can state the set: the serialised value is the driver's
    // string, spelled by declared scale ('1.00' for a stored 1, measured), and the database
    // admits every spelling of a member. A JSON Schema cannot run the canonical compare the
    // other generators emit, so it becomes a `pattern`: one branch per member, accepting
    // exactly the spellings that canonicalise to it. That is this format's honest cost: the
    // document stays ajv strict valid and exact, and what it gives up is the regex's
    // readability, not admitted rows.
    if (comparisonWire(c) === 'numeric-string') {
      return { type: 'string', pattern: canonicalSetPattern(set.values, c.dbType === 'BIGINT') };
    }
    return {
      enum: set.values.map((v) =>
        set.kind === 'string' || c.tsType === 'bigint' ? v : Number(v)
      ),
    };
  }

  if (c.enumValues && c.enumValues.length) {
    // A declared enum this document publishes once, or the list itself. See `enums.ts` for which
    // enums are shared and why a reference is not always usable.
    const ref = enumRef?.(c.enumValues);
    return ref ? { $ref: ref } : { enum: [...c.enumValues] };
  }

  const mine = c.arrayDimensions ? [] : checks.filter((k) => k.column === c.name);
  const eq = mine.find((k) => k.operator === '=');
  if (eq) {
    // A pinned value on a numeric string wire is a one-member set, and takes the same pattern
    // the set branch takes, for the same reason: the driver spells it by declared scale.
    if (comparisonWire(c) === 'numeric-string') {
      return { type: 'string', pattern: canonicalSetPattern([eq.value], c.dbType === 'BIGINT') };
    }
    // The wire rule the set above applies: on a bigint column the serialised value is a digit
    // string, so the pinned value is one too, and it stays exact where `Number` would round.
    const only = eq.kind === 'string' || c.tsType === 'bigint' ? eq.value : Number(eq.value);
    // OpenAPI 3.0 has no `const`, and its Schema Object is closed, so emitting one there does not
    // merely lose the constraint: the document fails validation. A one-value `enum` is the same
    // statement in a keyword that dialect has, and a validator accepts exactly the same value.
    return target === 'openapi-3.0' ? { enum: [only] } : { const: only };
  }

  switch (c.tsType) {
    case 'string': {
      const out: Schema = { type: 'string' };
      if (c.format === 'uuid') out.format = UUID_FORMAT;
      else if (c.format && COLUMN_FORMATS[c.format]) out.pattern = COLUMN_FORMATS[c.format];
      if (c.maxLength !== undefined) out.maxLength = c.maxLength;
      applyByteCap(out, c, lengths);
      applyLengths(out, c, lengths);
      return out;
    }
    case 'number': {
      const out: Schema = { type: isIntegerColumn(c) ? 'integer' : 'number' };
      if (!c.arrayDimensions) applyNumericBounds(out, c, checks, target);
      return out;
    }
    case 'bigint':
      // `JSON.stringify` throws on a bigint, so in a JSON document this column is a string. The
      // pattern is what makes that string still mean an integer.
      //
      // The sign follows the column's floor: a `bigint unsigned` (min '0' from the analyzer)
      // never holds a negative, and the sign is the one half of its range a pattern can state
      // exactly, so '-1' stops validating there. Magnitude stays unstated in both spellings:
      // neither 2^63-1 nor 2^64-1 survives a JSON number, which is why the column is a string in
      // the first place.
      return {
        type: 'string',
        pattern: typeof c.min === 'string' && !c.min.startsWith('-') ? '^\\d+$' : '^-?\\d+$',
      };
    case 'boolean':
      return { type: 'boolean' };
    case 'Date':
      // Dates arrive as ISO strings once serialised, whatever `coerceDates` does in TypeScript.
      return { type: 'string', format: 'date-time' };
    case 'Uint8Array':
      return base64(target);
    default:
      return {};
  }
}

/**
 * A byte budget, as the strongest thing this format can say about one.
 *
 * MySQL's TEXT family is capped by the type in bytes rather than by a declared length in
 * characters, so the analyzer carries it as `maxBytes` and the four validation generators encode
 * the string and count the result. There is no keyword for that here. No draft has a byte length,
 * and inventing one is worse than saying nothing: ajv in strict mode throws on `maxBytes`, and
 * with strict mode off it ignores the keyword and takes a thousand byte string into a 255 byte
 * column, which is a document that looks enforced and is not.
 *
 * `maxLength` counts characters, which is a different measurement of the same string. It is a
 * true statement about a byte budget in one direction only: UTF-8 spends at least one byte per
 * character, so a string inside the budget is always inside a character cap of the same number.
 * The cap emitted here therefore refuses nothing the column accepts, and it catches every
 * overflow made of one-byte characters. It cannot catch a multi-byte string that fits the count
 * and not the budget, so that is written into `description` rather than left unsaid.
 *
 * Measured against a real MySQL 8 on utf8mb4 in STRICT_TRANS_TABLES, on `TINYTEXT`, over the same
 * 150 seeded random strings before and after. Made of one-byte characters, the uncapped document
 * took 20 strings the server refused and the capped one takes none. Made of mixed one, two, three
 * and four byte characters, 88 becomes 68: what is left is the part the paragraph above says
 * cannot be expressed. Neither document refused anything the server took.
 * `test/byte-caps.spec.ts` has the targeted probes.
 *
 * The minimum rather than an assignment, so the smaller of the two caps a column carries is the
 * one that survives. The two forms agree on every column the analyzer produces today, and not by
 * luck: where a declared length and a byte budget arrive together the budget is the smaller of
 * them or equal to it, which `scripts/verify-packed.sh` asserts per column on both drizzle-orm
 * majors. The test asserting this one uses a column with a smaller character limit, where
 * assignment would widen the cap and take an eleventh character.
 *
 * Before `applyLengths`, so a `CHECK (length(col) <= n)` narrower than the budget still wins:
 * that one is reachable from a real schema, and it is asserted too.
 *
 * The budget itself is the smallest of the ones the column carries, whether it came from the type
 * or from a `CHECK (octet_length(col) <= n)`, so the prose names the number actually in force. Two
 * budgets with the description written from the wrong one is a document stating a limit looser than
 * its own `maxLength`.
 */
function applyByteCap(out: Schema, c: Column, lengths: LengthCheck[]) {
  const budget = byteBudget(c, lengths);
  if (budget === undefined) return;
  out.maxLength = Math.min(Number(out.maxLength ?? Infinity), budget);
  out.description = BYTE_BUDGET_NOTE(budget);
}

/** The inclusive upper bound a count clause states, or nothing where it states no ceiling. */
function ceilingOf(k: LengthCheck): number | undefined {
  if (k.operator === '<=' || k.operator === '=') return Number(k.value);
  if (k.operator === '<') return Number(k.value) - 1;
  return undefined;
}

/** Every byte ceiling on a column, as the one number that binds: the smallest of them. */
function byteBudget(c: Column, lengths: LengthCheck[]): number | undefined {
  const bounds = [
    ...(c.maxBytes ? [c.maxBytes] : []),
    ...lengths
      .filter((k) => k.column === c.name && k.unit === 'bytes')
      .map(ceilingOf)
      .filter((n): n is number => n !== undefined),
  ];
  return bounds.length ? Math.min(...bounds) : undefined;
}

/**
 * `length(col) >= n` as `minLength` and `maxLength`, which count characters as SQL does.
 *
 * A `CHECK (octet_length(col) <= n)` is a *byte* budget rather than a character count, so it goes
 * through `applyByteCap` with the type's own budget and is skipped here. The two are different
 * measurements of the same string and the difference is the whole reason the parser carries a unit:
 * measured on PostgreSQL 17.5, a string of three emoji answers 3 to `length()` and 12 to
 * `octet_length()`, so a byte bound written as a character count would be four times looser than
 * the constraint at worst.
 *
 * A byte *floor* reaches no keyword at all. `octet_length(t) >= 10` implies only `length(t) >= 3`,
 * since UTF-8 spends at most four bytes per character, which is a bound that catches almost nothing
 * and one more formula to be wrong about.
 */
function applyLengths(out: Schema, c: Column, lengths: LengthCheck[]) {
  for (const k of lengths.filter((x) => x.column === c.name && x.unit !== 'bytes')) {
    const n = Number(k.value);
    if (k.operator === '>=') out.minLength = Math.max(Number(out.minLength ?? 0), n);
    else if (k.operator === '>') out.minLength = Math.max(Number(out.minLength ?? 0), n + 1);
    else if (k.operator === '<=') out.maxLength = Math.min(Number(out.maxLength ?? Infinity), n);
    else if (k.operator === '<') out.maxLength = Math.min(Number(out.maxLength ?? Infinity), n - 1);
    else if (k.operator === '=') {
      out.minLength = n;
      out.maxLength = n;
    }
  }
}

/**
 * A byte budget on a binary column, as a cap on the base64 string that carries it.
 *
 * A `bytea` cannot travel as JSON, so the document describes it as base64 and the only length this
 * format can bound is the encoded string's. Base64 of n bytes is exactly `4 * ceil(n / 3)`
 * characters when padded and fewer when not, measured over n = 0 to 20, so that number is an upper
 * bound under either spelling and refuses nothing the column accepts. It is not a tight one: 6
 * bytes encode to the same 8 characters as 5, so a cap of 5 bytes still lets a 6 byte value
 * through. The exact rule goes in `description`, as every other cap this generator cannot state
 * does.
 *
 * Only the ceiling. A base64 *minimum* would have to hold for the unpadded spelling too, and the
 * two disagree by up to two characters at every length, so the bound would be looser than the
 * arithmetic makes it look for no gain.
 */
function applyBinaryLengths(out: Schema, c: Column, lengths: LengthCheck[]) {
  const budget = byteBudget(c, lengths);
  if (budget === undefined) return;
  out.maxLength = 4 * Math.ceil(budget / 3);
  out.description =
    `At most ${budget} bytes, which JSON Schema has no keyword for. The value travels as ` +
    `base64, and maxLength counts the characters of that encoding: it refuses nothing the ` +
    `column accepts, and a value one or two bytes over the limit encodes to the same number of ` +
    `characters as one inside it.`;
}

const BYTE_BUDGET_NOTE = (n: number) =>
  `At most ${n} bytes of UTF-8, which JSON Schema has no keyword for. maxLength counts ` +
  `characters: it refuses nothing the column accepts, and a string of multi-byte characters can ` +
  `satisfy it and still be too long for the column.`;

/**
 * Declared range and CHECK comparisons as numeric keywords.
 *
 * 2020-12 spells an exclusive bound as its own keyword holding the bound. OpenAPI 3.0 spells it
 * as a boolean beside `minimum`, which means the same thing and is written nowhere near the same
 * way. Getting this wrong produces a schema that reads as inclusive, silently accepting the one
 * value the constraint exists to exclude.
 */
function applyNumericBounds(
  out: Schema,
  c: Column,
  checks: ColumnCheck[],
  target: JsonSchemaTarget
) {
  let min: { value: number; exclusive: boolean } | undefined =
    c.min !== undefined ? { value: Number(c.min), exclusive: false } : undefined;
  let max: { value: number; exclusive: boolean } | undefined =
    c.max !== undefined ? { value: Number(c.max), exclusive: false } : undefined;

  for (const k of checks.filter((x) => x.column === c.name && x.kind === 'number')) {
    if (k.operator === '>=') min = { value: Number(k.value), exclusive: false };
    else if (k.operator === '>') min = { value: Number(k.value), exclusive: true };
    else if (k.operator === '<=') max = { value: Number(k.value), exclusive: false };
    else if (k.operator === '<') max = { value: Number(k.value), exclusive: true };
  }

  const old = target === 'openapi-3.0';
  if (min) {
    if (min.exclusive && !old) out.exclusiveMinimum = min.value;
    else {
      out.minimum = min.value;
      if (min.exclusive) out.exclusiveMinimum = true;
    }
  }
  if (max) {
    if (max.exclusive && !old) out.exclusiveMaximum = max.value;
    else {
      out.maximum = max.value;
      if (max.exclusive) out.exclusiveMaximum = true;
    }
  }
}

/** `cardinality(col) >= n` as array bounds. Exclusive becomes the next integer, which is exact. */
function cardinalityBounds(c: Column, cardinalities: CardinalityCheck[]): Schema {
  if (!c.arrayDimensions) return {};
  const out: Schema = {};
  for (const k of cardinalities.filter((x) => x.column === c.name)) {
    const n = Number(k.value);
    if (k.operator === '>=') out.minItems = n;
    else if (k.operator === '>') out.minItems = n + 1;
    else if (k.operator === '<=') out.maxItems = n;
    else if (k.operator === '<') out.maxItems = n - 1;
    else if (k.operator === '=') {
      out.minItems = n;
      out.maxItems = n;
    }
  }
  return out;
}

/**
 * A nullable schema, in whichever way the target spells it.
 *
 * 2020-12 has no `nullable` keyword: a value that may be null says so in its `type`. OpenAPI 3.0
 * has no type array: it has `nullable: true`. A schema with no `type` at all, such as a json
 * column, already accepts null in 2020-12 and needs nothing.
 */
function makeNullable(s: Schema, target: JsonSchemaTarget): Schema {
  if (target === 'openapi-3.0') return { ...s, nullable: true };
  // A reference has nothing to add null to, and adding a key beside it is the OpenAPI 3.0 trap in
  // reverse: `{ $ref, type: [...] }` says nothing about the referenced schema. `anyOf` is the
  // spelling that does, and it validates against the real 3.1 meta-schema.
  if ('$ref' in s) return { anyOf: [s, { type: 'null' }] };
  if (s.type === undefined) {
    // `const` and `enum` constrain the value directly, so null has to be added to them instead.
    if (Array.isArray(s.enum)) return { ...s, enum: [...s.enum, null] };
    if ('const' in s) {
      const { const: k, ...rest } = s;
      return { ...rest, enum: [k, null] };
    }
    return s;
  }
  return { ...s, type: [s.type as string, 'null'] };
}

function columnSchema(
  c: Column,
  mode: Mode,
  target: JsonSchemaTarget,
  checks: ColumnCheck[],
  sets: ColumnSet[],
  lengths: LengthCheck[],
  cardinalities: CardinalityCheck[],
  applyDefault: boolean,
  enumRef?: EnumRefResolver
): Schema {
  const wantsDefault = mode === 'insert' && applyDefault && c.defaultValue !== undefined;
  // OpenAPI 3.0 defines every sibling of `$ref` to be ignored, so a reference cannot carry the two
  // keywords this function adds: `nullable: true` beside one is a schema that refuses null, and a
  // `default` beside one is a value no reader sees. Both wrappers land on the *column*, so an array
  // of enums is unaffected: the reference is on the element and the wrapper is on the array.
  const refBlockedBy30 =
    target === 'openapi-3.0' && !c.arrayDimensions && (c.nullable || wantsDefault);
  let s = baseSchema(c, mode, target, checks, sets, lengths, refBlockedBy30 ? undefined : enumRef);
  // Drizzle keeps an array on the element's own column class, so everything above describes the
  // element and the wrapping belongs here.
  const dims = c.arrayDimensions ?? 0;
  for (let i = 0; i < dims; i++) {
    s = { type: 'array', items: s, ...(i === dims - 1 ? cardinalityBounds(c, cardinalities) : {}) };
  }
  if (c.nullable) s = makeNullable(s, target);
  if (mode === 'insert' && applyDefault && c.defaultValue !== undefined) {
    s = { ...s, default: c.defaultValue };
  }
  return s;
}

/**
 * Row-level checks, as prose.
 *
 * JSON Schema cannot compare one property against another. `dependentSchemas` and `if`/`then` can
 * branch on a property's presence or on a fixed value, and neither can express `lo < hi`. Saying
 * so in the description is the whole of what the format allows, and it beats emitting something
 * that looks enforced and is not.
 */
function rowDescription(rows: RowCheck[], cols: Column[]): string | undefined {
  const present = new Set(cols.map((c) => c.name));
  const applicable = rows.filter((r) => present.has(r.left) && present.has(r.right));
  if (!applicable.length) return undefined;
  const list = applicable
    .map((r) => `${r.name ? `${r.name}: ` : ''}${r.left} ${r.operator} ${r.right}`)
    .join('; ');
  return `Row constraints not expressible in JSON Schema: ${list}`;
}

function tableSchema(
  table: Table,
  cols: Column[],
  mode: Mode,
  target: JsonSchemaTarget,
  applyDefaults: boolean,
  parsed: ReturnType<typeof collect>,
  enums: EnumPlan | undefined,
  /** `$defs` for a standalone module; absent where the definitions live in the document instead. */
  localDefs: boolean
): Schema {
  const properties: Schema = {};
  const required: string[] = [];
  for (const c of cols) {
    properties[c.name] = columnSchema(
      c,
      mode,
      target,
      parsed.checks,
      parsed.sets,
      parsed.lengths,
      parsed.cardinalities,
      applyDefaults,
      enums?.resolve
    );
    // An update makes everything optional. On insert a column the database will fill in may be
    // omitted. On select nothing may be: the row came out of the database, so every column has a
    // value, and a defaulted column has one more reliably than most. Treating `hasDefault` as
    // "optional" in every mode made `id` optional on a select schema, which describes a row that
    // cannot exist.
    //
    // A nullable column is still required: null is a value, and omitting the key is not the same
    // as sending null.
    const suppliedOnInsert =
      c.hasDefault || (applyDefaults && c.defaultValue !== undefined) || c.isGenerated;
    const optional = mode === 'update' || (mode === 'insert' && suppliedOnInsert);
    if (!optional) required.push(c.name);
  }
  const desc = rowDescription(parsed.rows, cols);
  // After the properties, so it holds exactly the enums this schema referenced. A `$defs` entry
  // nothing points at is dead weight in the consumer's bundle, and one that is missing is a
  // dangling `$ref` that ajv refuses to compile at all.
  const defs = localDefs ? (enums?.definitions() ?? {}) : {};
  return {
    ...(target === 'draft-2020-12' ? { $schema: DRAFT } : {}),
    $id: `${table.tsName}.${mode}`,
    title: `${mode} ${table.tsName}`,
    ...(desc ? { description: desc } : {}),
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
    ...(Object.keys(defs).length ? { $defs: defs } : {}),
  };
}

/**
 * Every CHECK on a table that the shared parser understands, with the wire policy applied:
 * quoted literals the database compares numerically come back respelled number-kind, and
 * clauses no exact compare can state are dropped, left to the base schema and reported by the
 * constraint ledger. See `wireLiteralFit` in `@drzl/validation-core`.
 */
function collect(table: Table) {
  const parsed = (table.checks ?? []).map((k) => parseCheck(k.expression, k.name));
  const { checks, sets } = applyWirePolicy(
    table.columns,
    parsed.flatMap((p) => (p.ok ? p.checks : [])),
    parsed.flatMap((p) => (p.ok ? (p.sets ?? []) : []))
  );
  return {
    checks,
    sets,
    rows: parsed.flatMap((p) => (p.ok ? (p.rows ?? []) : [])),
    lengths: parsed.flatMap((p) => (p.ok ? (p.lengths ?? []) : [])),
    cardinalities: parsed.flatMap((p) => (p.ok ? (p.cardinalities ?? []) : [])),
  };
}

/** What a caller can say about the enums a set of schemas shares. */
export interface EnumSharingOptions {
  /**
   * The analysis's own enums, which is where a shared definition gets its *name*.
   *
   * Omitted, every enum is inlined at every use, which is what this generator did before. A column
   * carries its values and no name at all, and `mood` is a better key than anything derivable from
   * `['sad','ok','happy']`, so an enum the analysis does not name stays inline.
   */
  enums?: Enum[];
}

/**
 * The three schemas for one table, as data rather than as source.
 *
 * A shared enum lands in this schema's own `$defs`, and only on `draft-2020-12`. The other two
 * targets describe a schema destined for an OpenAPI document, where `$defs` is either invalid
 * outright (3.0's Schema Object is closed) or valid and unresolvable (3.1 resolves a `$ref` against
 * the document root, so `#/$defs/mood` names nothing). Both measured. A document shares through
 * `components.schemas` instead; see `componentsDocument`.
 *
 * The scope is one schema, so an enum has to be on two columns of *this mode* to be shared. Deciding
 * it per table instead would put a `$defs` entry with one reference into the insert schema of a
 * table whose second use is a generated column.
 */
export function tableSchemas(
  table: Table,
  opts: { target?: JsonSchemaTarget; applyDefaults?: boolean } & EnumSharingOptions = {}
): Record<Mode, Schema> {
  const target = opts.target ?? 'draft-2020-12';
  const parsed = collect(table);
  const localDefs = target === 'draft-2020-12';
  const build = (cols: Column[], mode: Mode) => {
    const plan = localDefs
      ? planSharedEnums(cols, opts.enums, (key) => `#/$defs/${key}`)
      : undefined;
    return tableSchema(table, cols, mode, target, !!opts.applyDefaults, parsed, plan, localDefs);
  };
  return {
    insert: build(insertColumns(table), 'insert'),
    update: build(updateColumns(table), 'update'),
    select: build(selectColumns(table), 'select'),
  };
}

/**
 * The same three schemas, sharing enums through a plan somebody else owns.
 *
 * `componentsDocument` and `openApiDocument` share over the whole document rather than over one
 * schema, and they publish the definitions beside the table schemas rather than inside them. So the
 * plan is built once out there and handed down, and nothing here emits a `$defs`.
 */
function tableSchemasWith(
  table: Table,
  target: JsonSchemaTarget,
  applyDefaults: boolean,
  plan: EnumPlan | undefined,
  modes: readonly Mode[] = MODES
): Record<Mode, Schema> {
  const parsed = collect(table);
  const columns: Record<Mode, () => Column[]> = {
    insert: () => insertColumns(table),
    update: () => updateColumns(table),
    select: () => selectColumns(table),
  };
  const out = {} as Record<Mode, Schema>;
  for (const mode of modes) {
    out[mode] = tableSchema(
      table,
      columns[mode](),
      mode,
      target,
      applyDefaults,
      parsed,
      plan,
      false
    );
  }
  return out;
}

/**
 * Every table's schemas as one `components.schemas` object, ready to drop into an OpenAPI
 * document.
 *
 * The per-table modules are the useful unit for a TypeScript program; a document wants one object
 * keyed by name. Assembling it is the step everyone repeats, and two details are easy to get
 * quietly wrong:
 *
 * - `$schema` has to go. Nested under `components.schemas` a schema inherits the document's
 *   dialect, and in OpenAPI 3.1 a per-schema `$schema` is read as a dialect switch.
 * - `$id` has to go too, and not become `#/components/schemas/<name>` as the obvious first
 *   attempt did. A draft 2020-12 `$id` may not contain a fragment, and ajv rejects the schema
 *   outright: `data/$id must match pattern "^[^#]*#?$"`. In OpenAPI the **map key** is the
 *   identity, and `$ref: '#/components/schemas/<name>'` is written by whatever points at it, not
 *   by the schema itself.
 *
 * **No shared enum definitions here, and that is the one place this differs from `openApiDocument`.**
 * A `$ref` is a promise about where the thing holding it will be mounted, and this object is a
 * fragment whose mount point is the caller's: `#/components/schemas/mood` is resolvable once it has
 * been spread into a document at exactly that path and nowhere else. Every entry here is therefore
 * self-contained, so a caller can hand one schema to a validator on its own, which
 * `scripts/verify-packed.sh` does and which a cross-reference silently breaks: ajv answers
 * `can't resolve reference #/components/schemas/mood from id #`. The whole document knows where it
 * is and does share; see `openApiDocument`.
 */
export function componentsDocument(
  tables: Table[],
  opts: { target?: JsonSchemaTarget; applyDefaults?: boolean } = {}
): { schemas: Record<string, Schema> } {
  const target = opts.target ?? 'draft-2020-12';
  const schemas: Record<string, Schema> = {};
  for (const table of tables) {
    const built = tableSchemasWith(table, target, !!opts.applyDefaults, undefined);
    for (const mode of MODES) {
      const { $schema: _dialect, $id: _id, ...rest } = built[mode];
      schemas[componentSchemaName(table, mode)] = rest;
    }
  }
  return { schemas };
}

const MODES = ['insert', 'update', 'select'] as const;

/** The map key a table's schema is published under, which is also what a `$ref` to it spells. */
export const componentSchemaName = (table: Table, mode: Mode) =>
  `${table.tsName}${mode[0].toUpperCase()}${mode.slice(1)}`;

/**
 * Every table's schemas for a document, plus the shared enum definitions to publish beside them.
 *
 * The half of `componentsDocument` that `openApiDocument` needs, which is not quite the same thing:
 * a document carries only the modes something points at, and it reserves `Error` for its own use.
 */
export function documentSchemas(
  tables: Table[],
  opts: {
    target: JsonSchemaTarget;
    applyDefaults: boolean;
    reserved: ReadonlySet<string>;
    /**
     * Which modes of each table the document carries.
     *
     * Only those are built, so `definitions()` holds exactly the enums something in the document
     * points at. Built unconditionally, a table whose only enum column sits in a mode the document
     * drops would publish a definition nothing references.
     */
    modes: (table: Table) => readonly Mode[];
  } & EnumSharingOptions
): {
  built: Map<Table, Partial<Record<Mode, Schema>>>;
  definitions: () => Record<string, { enum: string[] }>;
} {
  const plan = planSharedEnums(
    tables.flatMap((t) => t.columns),
    opts.enums,
    (key) => `#/components/schemas/${key}`,
    opts.reserved
  );
  const built = new Map<Table, Partial<Record<Mode, Schema>>>();
  for (const table of tables) {
    const all = tableSchemasWith(table, opts.target, opts.applyDefaults, plan, opts.modes(table));
    built.set(table, all);
  }
  return { built, definitions: () => plan?.definitions() ?? {} };
}
