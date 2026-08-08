import type { Analysis, Column, Table } from '@drzl/analyzer';
import type {
  ResolvedAffix,
  ValidationGenerateOptions,
  ValidationRenderer,
} from '@drzl/validation-core';
import type {
  ColumnCheck,
  ColumnSet,
  CardinalityCheck,
  LengthCheck,
  RowCheck,
} from '@drzl/validation-core';
import type { NestedNode, NestedMode } from '@drzl/validation-core';
import type { BrandPlan } from '@drzl/validation-core';
import type { ConstraintsOption } from '@drzl/validation-core';
import {
  buildBrandPlan,
  columnMetaFacts,
  formatCode,
  parseCheck,
  renderConstraintsModule,
  resolveConstraints,
  CONSTRAINTS_MODULE,
  renderDuplicateFinder,
  resolveConfiguredImport,
  buildNestedPlan,
  tableMetaFacts,
  COERCIBLE_DATE_STRING,
  COLUMN_FORMATS,
  importSpecifier,
  insertColumns,
  isIntegerColumn,
  lengthCheckLabel,
  lengthMeasure,
  measureExpression,
  moduleFileName,
  moduleSpecifier,
  nestedArmNotes,
  nestedNodeColumns,
  nestedSchemaName,
  nestedTypeName,
  nonFiniteAccepted,
  resolveAffix,
  resolveNestedDepth,
  schemaName,
  selectColumns,
  typeName,
  updateColumns,
} from '@drzl/validation-core';

type Mode = 'insert' | 'update' | 'select';

/**
 * What `meta` is asking for, once the boolean shorthand is expanded.
 *
 * `undefined` means off, which is the default: every byte here ships in the consumer's bundle and
 * most consumers never read it.
 */
interface MetaPlan {
  /** Also write prose, which is what an OpenAPI viewer renders. Its own flag; see the option. */
  description: boolean;
  /** A fact about the analysis rather than about any one table, so it travels with the plan. */
  dialect?: string;
}

/**
 * `.meta({ ... })`, or nothing when the facts are empty and the call would say nothing.
 *
 * `JSON.stringify` rather than a hand-rolled object literal: every value here comes from a schema
 * the user wrote, so a table named `it's` or a CHECK holding a quote has to survive into valid
 * TypeScript. The formatter unquotes the keys that do not need quoting.
 */
function metaCall(facts: object): string {
  if (!Object.keys(facts).length) return '';
  return `.meta(${JSON.stringify(facts)})`;
}

function resolveMeta(opt: ZodGenerateOptions['meta'], dialect?: string): MetaPlan | undefined {
  if (!opt) return undefined;
  if (opt === true) return { description: false, dialect };
  if (opt.enabled === false) return undefined;
  return { description: !!opt.description, dialect };
}

/**
 * Suffix appended to the Drizzle export name for every emitted file. The barrel derives
 * its import specifiers from whatever value wins here, so overriding it with `fileSuffix`
 * renames the files and the exports together.
 */
const DEFAULT_FILE_SUFFIX = '.zod.ts';

/**
 * `.gte(min).lte(max)` for a column that declares an integer range, or nothing.
 *
 * The bounds arrive as decimal strings because a 64 bit bound is not representable as a JS
 * number, so they are pasted through rather than parsed. `literal` decides how each is spelled,
 * which is the only difference between the number and bigint cases.
 */
function numericBounds(
  c: Column,
  literal: (v: string) => string,
  checks: ColumnCheck[] = []
): string {
  let lo = c.min !== undefined ? { op: 'gte', value: c.min } : undefined;
  let hi = c.max !== undefined ? { op: 'lte', value: c.max } : undefined;

  // A CHECK on this column replaces the end it narrows, rather than sitting beside it. It cannot
  // widen: the declared range is the column's type, and no CHECK makes an int32 hold more.
  //
  // `.gte(-2147483648).lte(2147483647).refine((v) => v >= 18)` was a bound that can never fail
  // plus a closure saying what the bound should have said. Folding costs a closure call per parse
  // and some bundle, and gains zod's own message: "Too small, expected number to be >=18", with
  // the bound machine-readable on the issue rather than inside a string this generator wrote.
  for (const k of checks.filter((x) => x.column === c.name && x.kind === 'number')) {
    if (k.operator === '>=') lo = { op: 'gte', value: k.value };
    else if (k.operator === '>') lo = { op: 'gt', value: k.value };
    else if (k.operator === '<=') hi = { op: 'lte', value: k.value };
    else if (k.operator === '<') hi = { op: 'lt', value: k.value };
  }

  return [lo, hi]
    .filter(Boolean)
    .map((x) => `.${x!.op}(${literal(x!.value)})`)
    .join('');
}

/**
 * The column widened by the non-finite doubles it really stores, or left exactly as it was.
 *
 * A union rather than a wider range, because no range can hold either value: `.gte()/.lte()`
 * refuses `Infinity` whatever the numbers are, and `NaN` compares false against both ends. The
 * range keeps describing the finite values of the column and each branch adds one more.
 *
 * Both infinity branches whenever the column admits them, unlike valibot and ArkType, because
 * zod 4 refuses a non-finite number with no bound at all: `z.number()` is `Number.isFinite`, so
 * there is no unbounded case here where the base already takes them. Measured on the installed
 * zod, which answers no to `NaN`, `Infinity` and `-Infinity` alike.
 */
function withNonFinite(c: Column, base: string): string {
  const { nan, infinity } = nonFiniteAccepted(c);
  const branches = [
    ...(nan ? ['z.nan()'] : []),
    ...(infinity ? ['z.literal(Infinity)', 'z.literal(-Infinity)'] : []),
  ];
  return branches.length ? `z.union([${base}, ${branches.join(', ')}])` : base;
}

/** Which checks `numericBounds` has already stated, so they are not also emitted as predicates. */
function foldedIntoBounds(c: Column, checks: ColumnCheck[]): Set<ColumnCheck> {
  if (c.arrayDimensions || c.shape) return new Set();
  if (c.tsType !== 'number' && c.tsType !== 'bigint') return new Set();
  return new Set(
    checks.filter(
      (k) => k.column === c.name && k.kind === 'number' && k.operator !== '=' && k.operator !== '<>'
    )
  );
}

/**
 * `.refine()` calls for the CHECK constraints that apply to this column.
 *
 * No official Drizzle validator emits these. Verified against `drizzle-orm/zod` at 1.0.0-rc.4:
 * a table with `check('age_adult', sql`${t.age} >= 18`)` yields an insert schema that happily
 * accepts `{ age: 5 }`.
 *
 * Only checks that name this column and compare it to a literal appear here; everything else is
 * skipped by the parser rather than guessed at. The message names the constraint, so a failure
 * points at the thing in the schema that caused it.
 */
/**
 * `.refine()` calls for the `length(col)` and `octet_length(col)` constraints naming this column.
 *
 * A character count is counted in code points, because Postgres counts characters. The same reason
 * `varchar(n)` is not `.max(n)`: `.length` is UTF-16 units and would refuse text the database
 * accepts. A byte count is the UTF-8 encoding of a string and the plain `.length` of a `bytea`'s
 * Uint8Array, which are two different expressions for the same SQL function. `lengthMeasure`
 * decides which, once per column, and the constraint ledger asks it the same question.
 */
function lengthRefinements(c: Column, lengths: LengthCheck[]): string {
  const OPS: Record<LengthCheck['operator'], string> = {
    '>=': '>=',
    '>': '>',
    '<=': '<=',
    '<': '<',
    '=': '===',
    '<>': '!==',
  };
  return lengths
    .filter((k) => k.column === c.name)
    .map((k) => {
      const measure = lengthMeasure(c, k);
      if (!measure) return '';
      const msg = JSON.stringify(lengthCheckLabel(k));
      const count = measureExpression(measure, 'v');
      return `.refine((v) => ${count} ${OPS[k.operator]} ${k.value}, { message: ${msg} })`;
    })
    .join('');
}

/**
 * `.refine()` calls for the `cardinality(col)` constraints naming this column.
 *
 * Only for an array column: on anything else there is nothing to count, and comparing `.length`
 * of a string would enforce a different constraint than the schema stated. This is the one check
 * an array column does take, since it is about the array rather than about an element.
 */
function cardinalityRefinements(c: Column, cardinalities: CardinalityCheck[]): string {
  if (!c.arrayDimensions) return '';
  const OPS: Record<CardinalityCheck['operator'], string> = {
    '>=': '>=',
    '>': '>',
    '<=': '<=',
    '<': '<',
    '=': '===',
    '<>': '!==',
  };
  return cardinalities
    .filter((k) => k.column === c.name)
    .map((k) => {
      const msg = JSON.stringify(
        `${k.name ? `${k.name}: ` : ''}cardinality(${c.name}) ${k.operator} ${k.value}`
      );
      return `.refine((v) => v.length ${OPS[k.operator]} ${k.value}, { message: ${msg} })`;
    })
    .join('');
}

function checkRefinements(c: Column, checks: ColumnCheck[]): string {
  // A parsed check compares this column to a scalar literal, which says nothing usable about an
  // array or a tuple. Emitting one anyway was actively harmful: `CHECK (tags = '{}')` became
  // `.refine((v) => v === '{}')` against a `string[]`, which no value can satisfy, so the schema
  // rejected every row.
  if (c.arrayDimensions || c.shape) return '';

  const folded = foldedIntoBounds(c, checks);
  const mine = checks.filter((k) => k.column === c.name && !folded.has(k));
  if (!mine.length) return '';

  const OPS: Record<ColumnCheck['operator'], string> = {
    '>=': '>=',
    '>': '>',
    '<=': '<=',
    '<': '<',
    '=': '===',
    '<>': '!==',
  };

  return mine
    .map((k) => {
      const rhs = k.kind === 'string' ? JSON.stringify(k.value) : k.value;
      const label = k.name ? `${k.name}: ` : '';
      const msg = JSON.stringify(
        `${label}${c.name} ${k.operator} ${k.kind === 'string' ? `'${k.value}'` : k.value}`
      );
      return `.refine((v) => v ${OPS[k.operator]} ${rhs}, { message: ${msg} })`;
    })
    .join('');
}

/**
 * A column whose value is structured rather than scalar.
 *
 * Everything here used to land on `z.any()`, `z.unknown()` or, for the tuple types, `z.string()`.
 * The string cases were the worst of the three: a `point` arrives as `[number, number]`, so the
 * emitted select schema rejected every row the database returned.
 */
function shapeExpr(c: Column, mode: Mode, typedJsonRef?: string): string | undefined {
  const s = c.shape;
  if (!s) return undefined;
  switch (s.kind) {
    case 'json':
      // `typedJson` still wins: the type Drizzle inferred is narrower than "any JSON".
      if (typedJsonRef) return `z.custom<${typedJsonRef}>()`;
      // Zod's own JSON value space. `z.any()` accepted `undefined`, `NaN`, `Infinity`, bigints,
      // Dates and Buffers, none of which survive the round trip through the column.
      return 'z.json()';
    case 'custom':
      // A `customType` column's JavaScript type exists only at compile time, and `fromDriver` can
      // map the SQL type to anything, so there is nothing to check at runtime and guessing from
      // `getSQLType()` would reject the real value. `typedJson` still recovers the *type*, from
      // Drizzle's own inference rather than from a guess, which `drizzle-orm/zod` does not do at
      // all: it emits `z.any()`, losing both the type and the narrowing `unknown` would force.
      return typedJsonRef ? `z.custom<${typedJsonRef}>()` : 'z.unknown()';
    case 'buffer':
      // `Uint8Array` rather than `Buffer`, which is deliberately wider than `drizzle-orm/zod`.
      // A Buffer is a Uint8Array, so everything official accepts is accepted here; the reverse
      // is not true. Both halves are asserted in test/structured-columns.spec.ts, which pushes a
      // plain `Uint8Array` and a `Buffer` at the emitted field.
      //
      // It is not "the one place" the output is wider, which is what this sentence and the docs
      // page both used to say. That is not a judgement, it is countable: `verify-packed.sh`
      // counts the waivers where DRZL accepts something official refuses and prints the number
      // on every run, and the float bounds released alongside this comment added six more.
      //
      // Reasons for the wider check: it needs no `@types/node` and so survives an edge or browser
      // build, `Buffer` is not defined in those runtimes at all and `v instanceof Buffer` would
      // throw rather than fail, and it makes a Postgres `bytea` and a SQLite `blob` validate
      // identically instead of by dialect.
      return 'z.instanceof(Uint8Array)';
    case 'tuple':
      return `z.tuple([${Array.from({ length: s.length }, () => 'z.number()').join(', ')}])`;
    case 'numberObject':
      // The object modes of the same columns: `point({ mode: 'xy' })` hands back `{ x, y }` and
      // `line({ mode: 'abc' })` hands back `{ a, b, c }`.
      //
      // Not `.strictObject`. Measured on PGlite through drizzle 0.45.2: `mapToDriverValue` reads
      // the named fields off whatever it is handed and ignores the rest, so `{ x: 1, y: 2, z: 3 }`
      // inserts and the column stores `(1,2)`. A strict object would refuse a write the server
      // takes. Every named field is required, on the same measurement: `{ x: 1 }` renders
      // `(1,undefined)` and Postgres answers `invalid input syntax for type point`.
      return `z.object({ ${s.fields.map((f) => `${f}: z.number()`).join(', ')} })`;
    case 'numberVector':
      return `z.array(z.number())${s.length ? `.length(${s.length})` : ''}`;
    case 'bitstring':
      // `.length` for a Postgres `bit(n)`, `.max` for a Cockroach `varbit(n)`: the first is a
      // fixed width, the second a ceiling, and `''` is valid only under the second.
      return (
        'z.string().regex(/^[01]*$/)' +
        (s.length ? (s.exact ? `.length(${s.length})` : `.max(${s.length})`) : '')
      );
    case 'byteString':
      // A MySQL/SingleStore `binary(n)`/`varbinary(n)`, which holds bytes and returns a string.
      // No pattern: the column takes any bytes at all, so `^[01]*$` rejected every row.
      //
      // The cap is the direction-dependent half. Measured against MySQL 8.4: a varbinary(3)
      // holding `<ff ff ff>` returns 3 code points that re-encode to 9 UTF-8 bytes, so a byte cap
      // on select refuses a row the column returned; and a varbinary(8) refuses 3 emoji, which is
      // 3 code points and 12 bytes, so a character cap on insert accepts a write the server does
      // not. Neither `.length` nor `.max` is either measurement: both count UTF-16 units.
      if (!s.length) return 'z.string()';
      return mode === 'select'
        ? `z.string().refine((v) => [...v].length <= ${s.length}, { message: 'at most ${s.length} characters' })`
        : `z.string().refine((v) => new TextEncoder().encode(v).length <= ${s.length}, { message: 'at most ${s.length} bytes' })`;
  }
}

function zodExprForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  typedJsonRef?: string,
  sets: ColumnSet[] = [],
  checks: ColumnCheck[] = []
): string {
  const shaped = shapeExpr(c, mode, typedJsonRef);
  if (shaped) return shaped;
  // `CHECK (status IN ('a', 'b'))` constrains the column to a set, which is what an enum is. It
  // takes the same shape here as a declared enum rather than becoming a predicate, so the static
  // type narrows too. No official validator module enforces it at all.
  const set = sets.find((x) => x.column === c.name);
  if (set) {
    return set.kind === 'string'
      ? `z.enum([${set.values.map((v) => JSON.stringify(v)).join(', ')}] as const)`
      : `z.union([${set.values.map((v) => `z.literal(${v})`).join(', ')}])`;
  }
  if (c.enumValues && c.enumValues.length) {
    const vals = c.enumValues.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(', ');
    return `z.enum([${vals}] as const)`;
  }
  switch (c.tsType) {
    case 'string':
      // A uuid is a string with a fixed shape, so the format supersedes any length: stacking
      // `.max(36)` on top would restate what the format already guarantees.
      if (c.format === 'uuid') return 'z.uuid()';
      // A format the database enforces. These replaced a bare `z.string()`, which accepted
      // `'hello'` for a numeric or inet column: `drizzle-orm/zod` still does, and Postgres does
      // not. Only formats verified against Postgres appear here, so nothing valid is turned away.
      const pattern = c.format ? COLUMN_FORMATS[c.format] : undefined;
      if (pattern) return `z.string().regex(new RegExp(${JSON.stringify(pattern)}))`;
      // Not `.max(n)`. A `varchar(n)` limit is n *characters*, and `.max` counts UTF-16 units, so
      // it refuses eight emoji in a `varchar(10)` the database is happy with. All four generators
      // count code points now; see `CODEPOINT_LENGTH` in validation-core for the measurements.
      // Two different measurements, and a column can carry either. `varchar(n)` counts
      // characters in both Postgres and MySQL; MySQL's TEXT family counts bytes, so a tinytext
      // takes 255 ascii characters and only 63 thumbs-up ones. Both verified against the servers.
      let str = 'z.string()';
      if (c.maxLength) {
        str += `.refine((v) => [...v].length <= ${c.maxLength}, { message: 'at most ${c.maxLength} characters' })`;
      }
      if (c.maxBytes) {
        str += `.refine((v) => new TextEncoder().encode(v).length <= ${c.maxBytes}, { message: 'at most ${c.maxBytes} bytes' })`;
      }
      return str;
    case 'number': {
      const base = isIntegerColumn(c) ? 'z.number().int()' : 'z.number()';
      return withNonFinite(c, base + numericBounds(c, (v) => v, checks));
    }
    case 'bigint':
      // Bounds have to be bigint literals. A 64 bit bound written as a plain number rounds, so
      // `.lte(9223372036854775807)` would silently become `.lte(9223372036854775808)`.
      return 'z.bigint()' + numericBounds(c, (v) => `${v}n`, checks);
    case 'boolean':
      return 'z.boolean()';
    case 'Date': {
      // Not `z.coerce.date()`. That is `new Date(v)` on anything at all, and `new Date(null)` is
      // the epoch, `new Date(true)` is one millisecond past it, and `new Date([1, 2])` parses as
      // a string, so a NOT NULL timestamp column accepted `null`, `true` and an array on insert.
      // Coercing only from the two types that carry a date, and validating the result, keeps the
      // intent while rejecting all three.
      //
      // Not every string either. `new Date` reads a bare number as a year or as month.day, so
      // `'12.5'`, `'0101'` and `'010'` were all real dates here and Postgres refuses all three.
      // A string that does not match `COERCIBLE_DATE_STRING` is passed through untouched and the
      // `z.date()` behind it turns it away; see that constant for what was measured and why.
      const coerced =
        `z.preprocess((v) => (typeof v === 'number' || (typeof v === 'string' && ` +
        `new RegExp(${JSON.stringify(COERCIBLE_DATE_STRING)}).test(v)) ? new Date(v) : v), z.date())`;
      if (coerceDates === 'all') return coerced;
      if (coerceDates === 'none') return 'z.date()';
      // 'input'
      return mode === 'select' ? 'z.date()' : coerced;
    }
    case 'Uint8Array':
      return 'z.instanceof(Uint8Array)';
    case 'any':
      // `typedJson` swaps the wide type for the one Drizzle inferred. Referencing
      // `typeof <table>.$inferSelect['<col>']` means TypeScript resolves `.$type<T>()` for us,
      // so generics, unions and imported interfaces all work without parsing any source.
      if (typedJsonRef) return `z.custom<${typedJsonRef}>()`;
      return 'z.any()';
    default:
      return 'z.unknown()';
  }
}

function zodField(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  typedJsonRef?: string,
  sets: ColumnSet[] = [],
  applyDefault = false,
  lengths: LengthCheck[] = [],
  cardinalities: CardinalityCheck[] = [],
  /**
   * A reference to Drizzle's inferred type for a column that already has a runtime schema.
   *
   * Distinct from `typedJsonRef`, which *replaces* the schema for a column that has no runtime
   * type worth checking. This one is appended, so the checks stay and only the static type
   * narrows.
   */
  narrowRef?: string,
  /** The column's metadata, already rendered. Appended last; see the call below for why. */
  metaSuffix = '',
  /** The nominal brand this column carries, or nothing. See `@drzl/validation-core`'s branding. */
  brand?: string
): string {
  let expr = zodExprForColumn(c, mode, coerceDates, typedJsonRef, sets, checks);
  // `.array()` does not give the column its own class in Drizzle, so everything above describes
  // the *element*. Length limits and integer bounds belong there, which is why the wrapping
  // happens out here rather than inside.
  for (let i = 0; i < (c.arrayDimensions ?? 0); i++) expr = `z.array(${expr})`;
  // Before nullability on purpose. A SQL CHECK passes when it evaluates to TRUE *or NULL*, so
  // wrapping the constrained type in `.nullable()` reproduces that exactly: null skips the
  // check, as the database does.
  expr += checkRefinements(c, checks);
  expr += lengthRefinements(c, lengths);
  // After the array wrapping above, because this constrains the array rather than an element.
  expr += cardinalityRefinements(c, cardinalities);
  // Before nullability, and that placement is the whole of the decision.
  //
  // A brand is an intersection, and `null & { ... }` is `never`, so branding a schema that
  // already admits null deletes the null arm from the inferred type while the runtime keeps
  // accepting it. Measured on zod 4.4.3: `z.number().nullable().brand<'users.id'>()` infers
  // `number & $brand<"users.id">`, with no `| null` anywhere, and `.parse(null)` still returns
  // null. That is a schema whose type lies about it. The other order infers
  // `(number & $brand<"users.id">) | null`, which is what the column is.
  //
  // Position is otherwise free here, unlike `.meta()` below: `.brand()` returns the *same object*
  // it was called on, measured by identity, so it is not a clone or a wrap and nothing downstream
  // of it can lose anything.
  if (brand) expr = `${expr}.brand<${JSON.stringify(brand)}>()`;
  // For selects, nullable columns should allow null values
  if (c.nullable) {
    expr = `${expr}.nullable()`;
  }
  if (mode === 'insert') {
    // A literal default can be reproduced, which makes the field optional on input and present
    // on output rather than merely absent. `.default()` supersedes `.optional()`: it already
    // makes the key optional, and stacking both would leave the default unreachable.
    if (applyDefault && c.defaultValue !== undefined) {
      expr = `${expr}.default(${JSON.stringify(c.defaultValue)})`;
    } else if (c.nullable || c.hasDefault) {
      // Omit generated columns at callsite; for remaining fields,
      // allow optional when nullable or has default.
      expr = `${expr}.optional()`;
    }
  } else if (mode === 'update') {
    // All update fields are optional; preserve nullability
    expr = `${expr}.optional()`;
  }
  // Last, and after the optional wrapper on purpose. `.pipe()` keeps a key optional in both the
  // parsed result and the inferred type, checked against zod rather than assumed, so the runtime
  // schema is untouched and only the static type narrows.
  //
  // Not on a branded column, and the two cannot be reconciled by reordering. `typedColumns` and
  // `branded` narrow the same column's static type, and whichever runs second wins: the pipe put
  // first erases the brand, and the brand put first is erased by the pipe. Applying the brand to
  // the reference instead has the null problem above, since a nullable column's inferred type is
  // `T | null` and intersecting that with a marker deletes the null. So the brand wins outright.
  // Nothing is lost for an ordinary key, whose branded type *is* Drizzle's inferred type plus a
  // marker; a key declared with `.$type<T>()` keeps `T` only if you leave it unbranded.
  if (narrowRef && !brand) expr = `${expr}.pipe(z.custom<${narrowRef}>())`;
  // After everything, including the pipe. `.meta()` returns a clone carrying the entry, so a
  // *clone* operation keeps it and a *wrapping* one does not: measured on zod 4.4.3, `.refine()`,
  // `.min()` and `.describe()` all preserve it, while `.nullable()`, `.optional()`, `.default()`,
  // `z.array()` and `.pipe()` each build a new schema whose own `.meta()` answers undefined. So
  // anywhere but last loses the metadata for every nullable column, every field of an update
  // schema, and every array. It is also the position `z.toJSONSchema` reads as the property's own
  // keywords rather than as one arm of its `anyOf`.
  return expr + metaSuffix;
}

function renderObjectShape(
  cols: Column[],
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  typedJson?: { table: string; mode: 'insert' | 'select'; allColumns?: boolean },
  sets: ColumnSet[] = [],
  applyDefaults = false,
  lengths: LengthCheck[] = [],
  cardinalities: CardinalityCheck[] = [],
  meta?: { plan: MetaPlan; table: Table },
  brands?: { plan: BrandPlan; tsName: string }
) {
  return cols
    .map((c) => {
      const refFor = (t: { table: string; mode: 'insert' | 'select' }) =>
        `typeof ${t.table}.$infer${t.mode === 'insert' ? 'Insert' : 'Select'}[${JSON.stringify(c.name)}]`;
      // A json or custom column has no runtime type worth checking, so the reference replaces the
      // schema outright. Every other column already has one, so the reference is appended instead
      // and narrows only the static type.
      const replaces = c.tsType === 'any' || c.shape?.kind === 'custom';
      const ref = typedJson && replaces ? refFor(typedJson) : undefined;
      const narrow = typedJson?.allColumns && !replaces ? refFor(typedJson) : undefined;
      const metaSuffix = meta
        ? metaCall(columnMetaFacts(c, meta.table, { description: meta.plan.description }))
        : '';
      const brand = brands?.plan.brandOf(brands.tsName, c.name);
      return `  ${JSON.stringify(c.name)}: ${zodField(c, mode, coerceDates, checks, ref, sets, applyDefaults, lengths, cardinalities, narrow, metaSuffix, brand)},`;
    })
    .join('\n');
}

/**
 * `.refine()` calls that belong on the object rather than on a field.
 *
 * `CHECK (start_date < end_date)` is a statement about the row: neither column alone can say
 * whether it holds, which is why it cannot be a field refinement. On the object it is exactly
 * expressible. No official Drizzle validator module emits it, and DRZL used to skip it too.
 *
 * Both sides are guarded for null and undefined first, reproducing SQL, where a comparison
 * involving NULL yields NULL and a CHECK passes on NULL. Without the guard a row omitting an
 * optional column would be rejected by a comparison the database never applied.
 */
function rowRefinements(rows: RowCheck[], cols: Column[]): string {
  const present = new Set(cols.map((c) => c.name));
  const OPS: Record<RowCheck['operator'], string> = {
    '>=': '>=',
    '>': '>',
    '<=': '<=',
    '<': '<',
    '=': '===',
    '<>': '!==',
  };
  return (
    rows
      // A check naming a column this mode does not include cannot be evaluated: an insert schema
      // omits generated columns, so the comparison would read undefined and always pass or fail.
      .filter((r) => present.has(r.left) && present.has(r.right))
      .map((r) => {
        const l = `v[${JSON.stringify(r.left)}]`;
        const rt = `v[${JSON.stringify(r.right)}]`;
        const msg = JSON.stringify(
          `${r.name ? `${r.name}: ` : ''}${r.left} ${r.operator} ${r.right}`
        );
        return (
          `.refine((v) => ${l} == null || ${rt} == null || ${l} ${OPS[r.operator]} ${rt}, ` +
          `{ message: ${msg}, path: [${JSON.stringify(r.left)}] })`
        );
      })
      .join('')
  );
}

/** Every CHECK on a table that the shared parser understands, split by what it constrains. */
function parsedChecksFor(table: Table) {
  const parsed = (table.checks ?? []).map((k) => parseCheck(k.expression, k.name));
  return {
    checks: parsed.flatMap((p) => (p.ok ? p.checks : [])),
    sets: parsed.flatMap((p) => (p.ok ? (p.sets ?? []) : [])),
    rows: parsed.flatMap((p) => (p.ok ? (p.rows ?? []) : [])),
    lengths: parsed.flatMap((p) => (p.ok ? (p.lengths ?? []) : [])),
    cardinalities: parsed.flatMap((p) => (p.ok ? (p.cardinalities ?? []) : [])),
  };
}

/** Push a rendered block one level deeper, so the nested object reads as one. */
function indentBlock(code: string, by = '  '): string {
  return code
    .split('\n')
    .map((line) => (line ? by + line : line))
    .join('\n');
}

/**
 * One object of a nested payload, with its relations expanded inline.
 *
 * Inline rather than by reference to a sibling schema. `.omit()` is the obvious way to say "the
 * child's insert schema without its foreign key", and it does not work: measured on zod 4.4.3,
 * `.omit()` on a schema carrying a `.refine()` **throws** `.omit() cannot be used on object
 * schemas containing refinements`, so every table with a row-level CHECK would emit a module that
 * threw the moment anything imported it. Rendering from the columns runs the same
 * `renderObjectShape` the plain schemas use, so a nested field cannot drift from its flat twin.
 */
function renderNestedObject(
  node: NestedNode,
  mode: NestedMode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  typedJson: { allColumns?: boolean } | undefined,
  applyDefaults: boolean,
  meta?: MetaPlan,
  brands?: BrandPlan
): string {
  const all = mode === 'insert' ? insertColumns(node.table) : selectColumns(node.table);
  const cols = nestedNodeColumns(all, node);
  const { checks, sets, rows, lengths, cardinalities } = parsedChecksFor(node.table);
  const tj = typedJson
    ? { table: node.table.tsName, mode, allColumns: typedJson.allColumns }
    : undefined;
  const fields = renderObjectShape(
    cols,
    mode,
    coerceDates,
    checks,
    tj,
    sets,
    applyDefaults,
    lengths,
    cardinalities,
    meta ? { plan: meta, table: node.table } : undefined,
    brands ? { plan: brands, tsName: node.table.tsName } : undefined
  );

  const arms = node.arms.map((arm) => {
    const notes = nestedArmNotes(arm)
      .map((n) => `  // ${n}\n`)
      .join('');
    const child = renderNestedObject(
      arm.child,
      mode,
      coerceDates,
      typedJson,
      applyDefaults,
      meta,
      brands
    );
    // A to-one may come back null: a relational query returns null where there is no matching
    // row, and accepting it never turns away something the query produced. Optional throughout,
    // because which relations a payload carries is the caller's choice on a write and the `with`
    // clause's on a read.
    const value = arm.single
      ? `${indentBlock(child).trimStart()}.nullable()`
      : `z.array(\n${indentBlock(indentBlock(child))}\n  )`;
    return `${notes}  ${JSON.stringify(arm.key)}: ${value}.optional(),`;
  });

  const body = [fields, ...arms].filter(Boolean).join('\n');
  // After the row refinements, for the same reason a field's metadata goes after its wrappers: on
  // an object `.refine()` is a clone rather than a wrap, so this order is not forced, but keeping
  // one rule for both positions means there is nothing to get wrong when either side changes.
  const tableMeta = meta
    ? metaCall(
        tableMetaFacts(node.table, {
          mode,
          dialect: meta.dialect,
          description: meta.description,
        })
      )
    : '';
  return `z.object({\n${body}\n})${rowRefinements(rows, cols)}${tableMeta}`;
}

/** The nested exports for one table, or nothing when it has no relations to describe. */
function renderNestedSchemas(
  table: Table,
  affix: ResolvedAffix,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  typedJson: { allColumns?: boolean } | undefined,
  applyDefaults: boolean,
  plans: Partial<Record<NestedMode, NestedNode>>,
  meta?: MetaPlan,
  brands?: BrandPlan
): string {
  const out: string[] = [];
  for (const mode of ['insert', 'select'] as const) {
    const plan = plans[mode];
    if (!plan) continue;
    const name = nestedSchemaName(mode, table.tsName, affix);
    const tname = nestedTypeName(mode, table.tsName, affix);
    const expr = renderNestedObject(
      plan,
      mode,
      coerceDates,
      typedJson,
      applyDefaults,
      meta,
      brands
    );
    const infer = mode === 'insert' ? 'input' : 'output';
    out.push(
      `export const ${name} = ${expr};\n\nexport type ${tname} = z.${infer}<typeof ${name}>;`
    );
  }
  return out.length ? `\n${out.join('\n\n')}\n` : '';
}

/** Every table a plan reaches, so a type-only import can name all of them. */
function nestedTables(node: NestedNode, into = new Set<string>()): Set<string> {
  into.add(node.table.tsName);
  for (const arm of node.arms) nestedTables(arm.child, into);
  return into;
}

function renderTableSchemas(
  table: Table,
  affix: ResolvedAffix,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  typedJson?: { schemaSpecifier: string; allColumns?: boolean },
  applyDefaults = false,
  wantsDuplicateFinder = false,
  nested: Partial<Record<NestedMode, NestedNode>> = {},
  meta?: MetaPlan,
  brands?: BrandPlan
) {
  const T = table.tsName;
  const insertSchema = schemaName('insert', T, affix);
  const updateSchema = schemaName('update', T, affix);
  const selectSchema = schemaName('select', T, affix);
  const insertType = typeName('insert', T, affix);
  const updateType = typeName('update', T, affix);
  const selectType = typeName('select', T, affix);
  const insertCols = insertColumns(table);
  const updateCols = updateColumns(table);
  const selectCols = selectColumns(table);
  // Only the checks this version can translate with certainty. The parser skips anything
  // ambiguous, since a schema that enforces a guess rejects rows the database would accept.
  const parsedChecks = (table.checks ?? []).map((k) => parseCheck(k.expression, k.name));
  const checks = parsedChecks.flatMap((p) => (p.ok ? p.checks : []));
  const sets = parsedChecks.flatMap((p) => (p.ok ? (p.sets ?? []) : []));
  const rows = parsedChecks.flatMap((p) => (p.ok ? (p.rows ?? []) : []));
  const lengths = parsedChecks.flatMap((p) => (p.ok ? (p.lengths ?? []) : []));
  const cardinalities = parsedChecks.flatMap((p) => (p.ok ? (p.cardinalities ?? []) : []));
  // Insert and select can disagree: a json column with a default is optional on insert, so its
  // inferred type differs. Each shape therefore references the matching inference.
  const tj = typedJson
    ? { table: table.tsName, mode: 'select' as const, allColumns: typedJson.allColumns }
    : undefined;
  const tjInsert = typedJson
    ? { table: table.tsName, mode: 'insert' as const, allColumns: typedJson.allColumns }
    : undefined;
  const forMeta = meta ? { plan: meta, table } : undefined;
  const forBrands = brands ? { plan: brands, tsName: T } : undefined;
  const bodyInsert = renderObjectShape(
    insertCols,
    'insert',
    coerceDates,
    checks,
    tjInsert,
    sets,
    applyDefaults,
    lengths,
    cardinalities,
    forMeta,
    forBrands
  );
  const bodyUpdate = renderObjectShape(
    updateCols,
    'update',
    coerceDates,
    checks,
    tjInsert,
    sets,
    applyDefaults,
    lengths,
    cardinalities,
    forMeta,
    forBrands
  );
  const bodySelect = renderObjectShape(
    selectCols,
    'select',
    coerceDates,
    checks,
    tj,
    sets,
    applyDefaults,
    lengths,
    cardinalities,
    forMeta,
    forBrands
  );
  // One per mode, because the mode is the only thing that differs and it is one of the facts.
  const tableMetaFor = (mode: Mode) =>
    meta
      ? metaCall(
          tableMetaFacts(table, { mode, dialect: meta.dialect, description: meta.description })
        )
      : '';
  // A type-only import: it disappears at build time, so this adds no runtime dependency on the
  // schema module and cannot create an import cycle at runtime.
  //
  // A nested shape references the columns of *other* tables, so those tables have to be named
  // here too or the reference would not resolve. Without this the module compiled fine until
  // `typedJson` and `nestedSchemas` were combined, and then named an identifier nothing imported.
  const referenced = new Set<string>([table.tsName]);
  for (const plan of Object.values(nested)) {
    if (plan) for (const name of nestedTables(plan)) referenced.add(name);
  }
  const schemaImport = typedJson
    ? `import type { ${[...referenced].join(', ')} } from '${typedJson.schemaSpecifier}';\n`
    : '';
  // A materialized view refuses every write, so an insert or update schema for one would describe
  // an operation the database always rejects. The select schema is the only meaningful one.
  const writes = table.readOnly
    ? ''
    : `export const ${insertSchema} = z.object({
${bodyInsert}
})${rowRefinements(rows, insertCols)}${tableMetaFor('insert')};

export const ${updateSchema} = z.object({
${bodyUpdate}
})${rowRefinements(rows, updateCols)}${tableMetaFor('update')};

`;
  const writeTypes = table.readOnly
    ? ''
    : `export type ${insertType} = z.input<typeof ${insertSchema}>;
export type ${updateType} = z.input<typeof ${updateSchema}>;
`;

  // Uniqueness is a fact about the table, so no per-row schema can see it. This checks the
  // half that needs no database: whether a batch collides with itself.
  const finder = wantsDuplicateFinder
    ? renderDuplicateFinder(table, `findDuplicate${T}`, insertType)
    : undefined;
  const duplicates = finder ? `\n${finder}\n` : '';

  const nestedCode = renderNestedSchemas(
    table,
    affix,
    coerceDates,
    typedJson,
    applyDefaults,
    nested,
    meta,
    brands
  );

  // The brand read back off the schema that carries it, rather than written out a second time.
  // Spelling it as `number & z.core.$brand<'users.id'>` would be a second statement of the
  // column's base type, and the two would drift the first time a column's expression changed.
  const brandAliases = (brands?.aliasesFor(T) ?? [])
    .map(
      (a) =>
        `/** The nominal type of ${T}.${a.column}. */\n` +
        `export type ${a.alias} = z.output<typeof ${selectSchema}>[${JSON.stringify(a.column)}];`
    )
    .join('\n\n');
  const brandCode = brandAliases ? `\n${brandAliases}\n` : '';

  return `import { z } from 'zod';
${schemaImport}
${writes}export const ${selectSchema} = z.object({
${bodySelect}
})${rowRefinements(rows, selectCols)}${tableMetaFor('select')};

${writeTypes}export type ${selectType} = z.output<typeof ${selectSchema}>;
${brandCode}${nestedCode}${duplicates}`;
}

export interface ZodGenerateOptions extends ValidationGenerateOptions {
  outputHeader?: { enabled?: boolean; text?: string };
  /**
   * Also emit `findDuplicate<Table>` beside the schemas: the rows in a batch that collide with an
   * earlier row on a unique constraint.
   *
   * Uniqueness is the one constraint a per-row validator structurally cannot see, since it is a
   * fact about the table. This checks the half that needs no database. Off by default, because
   * generated code ships in the consumer's bundle.
   */
  duplicateFinder?: boolean;
  /**
   * Attach the facts the analyzer knows and a zod schema cannot state, as `.meta()` on every
   * field and on every table schema.
   *
   * A validator says what a value must look like. It does not say where the value came from, and
   * nothing on `z.string()` distinguishes a `text` from a `varchar(40)`, says whether the database
   * fills it in, or names the key columns. This carries those, plus the two things the schema does
   * enforce and cannot show: a declared width and every CHECK constraint, both of which are
   * `.refine()` calls that `z.toJSONSchema` drops in silence.
   *
   * Off by default. Every byte lands in the consumer's bundle, and most consumers never read it.
   *
   * `{ description: true }` additionally writes a `description`, which `toJSONSchema` maps to the
   * JSON Schema keyword of that name and is what an OpenAPI viewer renders to a human. It is prose
   * and it repeats what the machine-readable keys beside it already say, so it is asked for
   * separately.
   *
   * zod only, deliberately. It is the one validator DRZL emits whose metadata has a defined
   * destination outside itself, and the placement question this answers had to be measured against
   * zod's own clone-versus-wrap behaviour rather than reasoned about. See the docs page.
   */
  meta?: boolean | { enabled?: boolean; description?: boolean };
  /**
   * Also emit `constraints.ts`: every CHECK, unique constraint, primary and foreign key on each
   * table, as plain data, plus `constraintForIssue` to map a validation issue back to the
   * constraint that caused it.
   *
   * For a consumer building forms. A schema states what a value must look like and never says
   * which constraint said so, so a failed parse gives a form a message and no way to attribute it;
   * and the two constraints a per-row schema cannot check at all, uniqueness and a foreign key,
   * are absent from the emitted module in every form. This is the table's constraints addressed by
   * name, with the operand of each as data rather than inside a sentence.
   *
   * Not `meta` written to a second file. `meta` describes a *field* and travels with the schema
   * into `z.toJSONSchema`; this describes the *table's constraints*, carries their names, and is
   * read without holding a schema at all. See `@drzl/validation-core`'s constraints module.
   *
   * Off by default, like every option that adds bytes to the consumer's bundle. `true` is the
   * shorthand for `{ enabled: true }`; `{ errorMap: false }` emits the data without the matcher.
   */
  constraints?: ConstraintsOption;
}

/**
 * The nested plans for one table, built once per mode.
 *
 * Returned as a partial map because the two modes disagree per table: `comments` is a child and
 * nothing else, so it has a nested select and no nested insert, and emitting an insert one anyway
 * would put a byte-for-byte copy of `InsertcommentsSchema` in the file under a second name.
 */
function nestedPlansFor(
  table: Table,
  analysis: Analysis,
  depth: number
): Partial<Record<NestedMode, NestedNode>> {
  const out: Partial<Record<NestedMode, NestedNode>> = {};
  for (const mode of ['insert', 'select'] as const) {
    // A read-only relation refuses every write, so it has no insert schema to nest into.
    if (mode === 'insert' && table.readOnly) continue;
    const plan = buildNestedPlan(table, analysis.tables, analysis.relations ?? [], mode, depth);
    if (plan) out[mode] = plan;
  }
  return out;
}

export class ZodGenerator implements ValidationRenderer<ZodGenerateOptions> {
  readonly library = 'zod' as const;
  constructor(private analysis: Analysis) {}

  async generate(opts: ZodGenerateOptions) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outDir);
    const files: string[] = [];
    await fs.mkdir(out, { recursive: true });
    const affix = resolveAffix(opts);
    const coerceDates = opts.coerceDates ?? 'input';
    const fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;
    // `typedJson` needs to import the schema back, so it is only possible when the schema path
    // is known. Silently doing nothing would be worse than saying why.
    // `typedColumns` is the wider form of the same idea and implies it: both need the schema
    // imported back in order to reference what Drizzle inferred.
    const wantsTypes = opts.typedJson || opts.typedColumns;
    const typedJson =
      wantsTypes && opts.schemaPath
        ? {
            schemaSpecifier: resolveConfiguredImport(
              opts.schemaPath,
              out,
              process.cwd(),
              opts.importExtension
            ),
            allColumns: !!opts.typedColumns,
          }
        : undefined;
    if (wantsTypes && !opts.schemaPath) {
      console.warn(
        '[drzl] typedJson was requested but the schema path is unknown, so json columns keep their wide type.'
      );
    }
    const nestedDepth = opts.nestedSchemas
      ? resolveNestedDepth(opts.nestedDepth, (m) => console.warn(m))
      : 0;
    // The dialect is a fact about the analysis rather than about any one table, and the same
    // declaration means different things across dialects, so it travels with the plan.
    const metaPlan = resolveMeta(opts.meta, this.analysis.dialect);
    // Built once for the whole analysis, because a foreign key is branded after the table it
    // points at and no single table knows that.
    const brands = buildBrandPlan(this.analysis.tables, opts.branded);
    for (const note of brands?.notes ?? []) console.warn(`[drzl] ${note}`);
    // File names deliberately stay on the raw Drizzle export name: affixes and tableCase
    // rename identifiers, never modules, so the barrel and importPath keep resolving.
    for (const table of this.analysis.tables) {
      const filePath = path.join(out, moduleFileName(table.tsName, fileSuffix));
      const code = renderTableSchemas(
        table,
        affix,
        coerceDates,
        typedJson,
        !!opts.applyDefaults,
        !!opts?.duplicateFinder,
        opts.nestedSchemas ? nestedPlansFor(table, this.analysis, nestedDepth) : {},
        metaPlan,
        brands
      );
      const formatted = await formatCode(
        buildHeader(opts.outputHeader) + code,
        filePath,
        opts.format
      );
      await fs.writeFile(filePath, formatted, 'utf8');
      files.push(filePath);
    }
    // Before the barrel, which re-exports it. A file of plain data with no import of its own, so
    // it is written the same way whatever the schemas above ended up looking like.
    const constraints = resolveConstraints(opts.constraints);
    if (constraints) {
      const constraintsPath = path.join(out, CONSTRAINTS_MODULE);
      const constraintsCode = renderConstraintsModule(this.analysis.tables, constraints);
      await fs.writeFile(
        constraintsPath,
        await formatCode(
          buildHeader(opts.outputHeader) + constraintsCode,
          constraintsPath,
          opts.format
        ),
        'utf8'
      );
      files.push(constraintsPath);
    }
    // Index barrel
    const indexPath = path.join(out, 'index.ts');
    const indexCode =
      this.renderIndex?.(this.analysis, opts) ?? this.defaultIndex(this.analysis, opts);
    const indexFormatted = await formatCode(
      buildHeader(opts.outputHeader) + indexCode,
      indexPath,
      opts.format
    );
    await fs.writeFile(indexPath, indexFormatted, 'utf8');
    files.push(indexPath);
    return files;
  }

  renderTable(table: Table, opts?: ZodGenerateOptions) {
    return renderTableSchemas(
      table,
      resolveAffix(opts),
      opts?.coerceDates ?? 'input',
      undefined,
      !!opts?.applyDefaults,
      !!opts?.duplicateFinder,
      {},
      resolveMeta(opts?.meta, this.analysis.dialect),
      buildBrandPlan(this.analysis.tables, opts?.branded)
    );
  }

  renderIndex?(analysis: Analysis, opts?: ZodGenerateOptions): string;

  private defaultIndex(analysis: Analysis, opts: ZodGenerateOptions) {
    const fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;
    const exports = analysis.tables
      .map((t) => `export * from '${moduleSpecifier(t.tsName, fileSuffix, opts.importExtension)}';`)
      .join('\n');
    // The ledger is named rather than suffixed, so its specifier is built from the module name
    // rather than from `fileSuffix`, and it is only exported when it was written.
    const ledger = resolveConstraints(opts.constraints)
      ? `export * from '${importSpecifier(`./${CONSTRAINTS_MODULE}`, opts.importExtension)}';\n`
      : '';
    return exports + '\n' + ledger;
  }
}

export default ZodGenerator;

function buildHeader(h?: { enabled?: boolean; text?: string }) {
  if (h && h.enabled === false) return '';
  const text = h?.text?.trim();
  const lines = text
    ? text.split(/\r?\n/).map((l) => `// ${l}`)
    : [
        '// Generated by DRZL (@drzl/*)',
        "// Generated output is granted to you under your project's license.",
        '// You may use, copy, modify, and distribute without attribution.',
      ];
  return lines.join('\n') + '\n\n';
}
