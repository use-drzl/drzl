import type { Analysis, Table, Column } from '@drzl/analyzer';
import type {
  ColumnCheck,
  ColumnSet,
  CardinalityCheck,
  LengthCheck,
  ResolvedAffix,
  RowCheck,
  ValidationRenderer,
  ValidationGenerateOptions,
} from '@drzl/validation-core';
import type { NestedMode, NestedNode } from '@drzl/validation-core';
import type { BrandPlan } from '@drzl/validation-core';
import {
  buildBrandPlan,
  buildNestedPlan,
  formatCode,
  nestedArmNotes,
  nestedNodeColumns,
  nestedSchemaName,
  nestedTypeName,
  resolveNestedDepth,
  CODEPOINT_LENGTH,
  COERCIBLE_DATE_STRING,
  COLUMN_FORMATS,
  insertColumns,
  isIntegerColumn,
  lengthCheckLabel,
  lengthMeasure,
  measureExpression,
  moduleFileName,
  moduleSpecifier,
  nonFiniteAccepted,
  parseCheck,
  parsesToADate,
  renderDuplicateFinder,
  resolveAffix,
  resolveConfiguredImport,
  schemaName,
  selectColumns,
  typeName,
  updateColumns,
  wireNumberLiteral,
} from '@drzl/validation-core';

type Mode = 'insert' | 'update' | 'select';

/**
 * Suffix appended to the Drizzle export name for every emitted file. The barrel derives its
 * import specifiers from whatever value wins here, so overriding it with `fileSuffix` renames
 * the files and the exports together.
 */
const DEFAULT_FILE_SUFFIX = '.effect.ts';

/**
 * Prefix on the Standard Schema wrapper that sits beside every emitted schema.
 *
 * The same shape as `NESTED_PREFIX` in `@drzl/validation-core`, so an affix keeps working
 * underneath it: `StandardNestedSelectusersSchema` is the wrapper for `NestedSelectusersSchema`.
 */
const STANDARD_PREFIX = 'Standard';

/**
 * The namespace the emitted modules import Schema under.
 *
 * `effect/Schema`, from `effect` core. Not `@effect/schema`, which stopped at 0.75.5 and predates
 * the move into core, and not the 4.0 beta, which is what the plan item was parked on. See
 * `test/effect-api-contract.spec.ts` for the version facts this generator was built against, all
 * of which are asserted rather than described.
 *
 * `effect` is an **optional** peer of this package, which is the one place it differs from the
 * other four validation generators, and the reason is measured rather than stylistic.
 * `drizzle-orm@1.0.0-rc.4` declares its own optional peer on `effect` as
 * `">=4.0.0-beta.83 || >=4.0.0"`, so drizzle's first-party effect validator targets the 4.0 beta
 * and this one targets 3.x. The two ranges are disjoint. npm installs a *required* peer
 * automatically, so declaring one put `effect@3` into any tree that also wanted drizzle v1 and the
 * install failed outright with ERESOLVE, for every consumer of `@drzl/cli` rather than only for
 * users of this generator, since the CLI depends on this package optionally and npm resolves the
 * peers of an optional dependency all the same. Measured both ways against a real
 * `npm install <tarball> drizzle-orm@1.0.0-rc.4`: required fails, optional installs cleanly.
 *
 * Nothing is lost by it. This package emits text and never imports `effect` itself, so an install
 * without it is a working install of the generator; what needs the peer is the emitted module, and
 * the very first line of that module says so.
 */
const NS = 'Schema';

/**
 * A CHECK operator as the JavaScript operator that means the same thing.
 *
 * `=` and `<>` widen to `===`/`!==` because SQL compares scalars by value and JavaScript's loose
 * operators would equate `0` with `''`.
 */
const OPS: Record<ColumnCheck['operator'], string> = {
  '>=': '>=',
  '>': '>',
  '<=': '<=',
  '<': '<',
  '=': '===',
  '<>': '!==',
};

/** `Schema.filter` with a description, which is what a failing parse reports. */
function filter(expr: string, description: string): string {
  return `${NS}.filter((v) => ${expr}, { description: ${JSON.stringify(description)} })`;
}

/** Attach one or more pipe steps to a base schema, or leave it exactly as it was. */
function piped(base: string, steps: string[]): string {
  return steps.length ? `${base}.pipe(${steps.join(', ')})` : base;
}

/** Name of the recursive JSON schema emitted into a file that has any json column. */
const JSON_CONST = 'DrzlJsonValue';

/**
 * A recursive definition of the JSON value space, emitted once per file.
 *
 * `Schema.Unknown` accepts `undefined`, `NaN`, `Infinity`, bigints, Dates and Buffers, none of
 * which survive a round trip through a json column. `Schema.suspend` is what lets the nested cases
 * refer back to the whole, so a `{ a: { b: [1, 'x'] } }` is checked all the way down.
 *
 * Two things here are measurements rather than style.
 *
 * **The plain-object guard comes before the record, not after it.** `Schema.Record` rebuilds its
 * output as a fresh object, and a `Schema.filter` placed after it therefore inspects that rebuild
 * rather than the input. A Date has no own enumerable string keys, so the record accepted it,
 * rebuilt it as `{}`, and the guard then reported a plain object. `Schema.Unknown` does not
 * rebuild, so the guard runs on the value as given and `Schema.compose` carries what survives into
 * the record. The valibot generator carries the same repair for the same reason; see its
 * `JSON_PREAMBLE`.
 *
 * **The number arm is `Schema.Finite`.** `Schema.Number` accepts `NaN` and both infinities, and
 * JSON has none of them: `JSON.stringify(NaN)` is the string `"null"`, so a value that passed here
 * would be stored as something else entirely.
 *
 * The encoded side is declared `unknown` rather than the value type. `Schema.compose` takes its
 * encoded type from the first schema, which is the `Schema.Unknown` the guard is attached to, so
 * the union's encoded type really is `unknown` and claiming otherwise does not compile.
 */
const JSON_PREAMBLE = `type ${JSON_CONST}Type =
  | string
  | number
  | boolean
  | null
  | readonly ${JSON_CONST}Type[]
  | { readonly [key: string]: ${JSON_CONST}Type };

const ${JSON_CONST}: ${NS}.Schema<${JSON_CONST}Type, unknown> = ${NS}.suspend(() =>
  ${NS}.Union(
    ${NS}.String,
    ${NS}.Finite,
    ${NS}.Boolean,
    ${NS}.Null,
    ${NS}.Array(${JSON_CONST}),
    // The plain-object test comes before the record, not after it. \`Schema.Record\` rebuilds its
    // output, so a check placed after it inspects that new object and reports every input as
    // plain. A Date sailed through: it has no own enumerable keys, so the record accepted it and
    // rebuilt it as \`{}\`.
    ${NS}.Unknown.pipe(
      ${NS}.filter(
        (o) => {
          if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
          const p = Object.getPrototypeOf(o);
          return p === Object.prototype || p === null;
        },
        { description: 'a plain object' }
      ),
      ${NS}.compose(${NS}.Record({ key: ${NS}.String, value: ${JSON_CONST} }), { strict: false })
    )
  )
);
`;

/**
 * The one expression a column whose type nothing can name emits, and the test for having emitted
 * it.
 *
 * A `customType`, a column the analyzer could not name, an `any` column and a typed json one all
 * arrive as this expression, alone or followed by the cast that narrows only the static type.
 *
 * The test exists so the nullable wrapper can recognise its own input. Unlike TypeBox, where a
 * `Type.Union([Type.Unknown(), Type.Null()])` silently stopped requiring its key, nothing here is
 * broken by the union; it is simply noise. `Schema.Unknown` already accepts `null`, and where a
 * cast has narrowed the static type that type comes from Drizzle's own `$inferSelect`, which
 * spells a nullable column `T | null` on its own.
 *
 * What the union cannot repair, and what no arrangement here can, is stated in
 * `effect-api-contract.spec.ts`: a `Schema.Unknown` field accepts a *missing* key, because a
 * missing key reads as `undefined` and `Schema.Unknown` accepts `undefined`. So a column the
 * analyzer cannot type is optional in practice even on select. TypeBox is in the same position.
 */
const UNKNOWN_EXPR = `${NS}.Unknown`;

function isUnknownExpr(expr: string): boolean {
  return expr === UNKNOWN_EXPR;
}

/**
 * The static type Drizzle inferred for this column, applied to an already-built schema.
 *
 * Effect has no `Type.Unsafe`, which is TypeBox's primitive for replacing an inferred type while
 * keeping the runtime checks. What it has is a schema *type*, so the claim goes in the register it
 * belongs to: a cast, which exists only at compile time and leaves the runtime schema untouched.
 * Every check the wrapped expression carried still runs, which `typed-columns.spec.ts` measures
 * rather than assumes.
 *
 * One type argument, not two. `Schema.Schema<A>` defaults its encoded type to `A`, which is right
 * for every expression this generator builds: nothing here transforms, so decoding, validating and
 * encoding are the same question throughout.
 */
function withNarrowedType(expr: string, ref: string): string {
  return `${expr} as unknown as ${NS}.Schema<${ref}>`;
}

/**
 * Bounds a numeric column declares, as pipe steps.
 *
 * Bounds arrive as decimal strings, because a 64 bit bound cannot survive a JS number, and are
 * pasted through rather than parsed. For a `number` column that is as exact as the emitted code can
 * be, since the literal becomes a JS number the moment it is parsed; the `bigint` case below keeps
 * the `n` suffix and stays exact.
 */
function numericBounds(c: Column, checks: ColumnCheck[]): string[] {
  let lo = c.min !== undefined ? { fn: 'greaterThanOrEqualTo', value: c.min } : undefined;
  let hi = c.max !== undefined ? { fn: 'lessThanOrEqualTo', value: c.max } : undefined;

  // A CHECK on this column replaces the end it narrows rather than sitting beside it. It cannot
  // widen: the declared range is the column's type, and no CHECK makes an int32 hold more. The
  // zod generator folds these the same way and for the same reason: a bound that can never fail
  // beside a predicate saying what the bound should have said is two things to read and one to
  // run.
  for (const k of checks.filter((x) => x.column === c.name && x.kind === 'number')) {
    if (k.operator === '>=') lo = { fn: 'greaterThanOrEqualTo', value: k.value };
    else if (k.operator === '>') lo = { fn: 'greaterThan', value: k.value };
    else if (k.operator === '<=') hi = { fn: 'lessThanOrEqualTo', value: k.value };
    else if (k.operator === '<') hi = { fn: 'lessThan', value: k.value };
  }

  return [lo, hi].filter(Boolean).map((x) => `${NS}.${x!.fn}(${x!.value})`);
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
 * The column widened by the non-finite doubles it really stores, or left exactly as it was.
 *
 * A union rather than a wider range, because no range can hold either value: a comparison refuses
 * `Infinity` whatever the numbers are, and `NaN` compares false against both ends.
 *
 * The direction of this is inverted against every other generator here, and it is the one place
 * where Effect's defaults differ from the rest in a way that matters. `z.number()` and
 * `Type.Number()` refuse all three outright, so those generators only ever *add* branches.
 * `Schema.Number` accepts all three, measured, so a column that stores none of them, which is
 * almost every numeric column, needs the constraint *emitted*. That is why the base below is
 * `Schema.Finite` and not `Schema.Number`, and why the constraint is unconditional rather than
 * left to the range: `Infinity >= 0` is true, so a lower bound alone does not exclude it.
 *
 * `Schema.Literal` holds an infinity, since effect compares a literal with `===` and
 * `Infinity === Infinity`. It cannot hold `NaN`, which is not equal to itself, so that branch is a
 * predicate.
 */
function nonFiniteBranches(c: Column): string[] {
  const { nan, infinity } = nonFiniteAccepted(c);
  return [
    ...(nan
      ? [`${NS}.Number.pipe(${filter('Number.isNaN(v)', 'NaN, which this column stores')})`]
      : []),
    ...(infinity ? [`${NS}.Literal(Infinity, -Infinity)`] : []),
  ];
}

function withNonFinite(c: Column, base: string): string {
  const branches = nonFiniteBranches(c);
  return branches.length ? `${NS}.Union(${base}, ${branches.join(', ')})` : base;
}

/**
 * A date column, coerced or not.
 *
 * `Schema.ValidDateFromSelf` rather than `Schema.DateFromSelf`, measured: the latter accepts
 * `new Date('nonsense')`, an Invalid Date, which is still a `Date` and which no `instanceof` can
 * tell apart from a real one. And not `Schema.Date`, which is a *transform* from a string and
 * therefore refuses the `Date` a select actually returns.
 *
 * A coercing position is stated as the union the value can really be, exactly as the other
 * generators state it. Nothing is transformed: the schema says what it accepts and hands it back.
 *
 * The string branch carries two constraints because they are two different questions.
 * `COERCIBLE_DATE_STRING` is the gate on the *shape* of the string, and `parsesToADate` is the gate
 * on the *result*: `'hello'`, `'zzz'` and `'25:99:99'` are none of them bare numbers, so the
 * pattern passed all of them and `new Date` returned an Invalid Date for all of them.
 *
 * Unlike TypeBox, neither branch needs a `typeof` guard. TypeBox routes both through one registered
 * kind, which therefore sees a string in one case and a number in the other and would hand a bigint
 * to `new Date`, which throws. Here the two predicates hang off `Schema.String` and `Schema.Number`
 * respectively, so each only ever runs on a value of its own type.
 *
 * The number branch is the epoch `coerceDates` documents beside the string. It keeps the result
 * check for a reason the string's does not carry: `Schema.Number` takes `1e300`, which is a good
 * number and not a date, since the `Date` range ends at +-8.64e15.
 */
function dateExpr(mode: Mode, coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>) {
  const plain = `${NS}.ValidDateFromSelf`;
  if (coerceDates === 'none') return plain;
  const fromString = piped(`${NS}.String`, [
    `${NS}.pattern(new RegExp(${JSON.stringify(COERCIBLE_DATE_STRING)}))`,
    filter(parsesToADate('new Date(v)'), 'a date the runtime can parse'),
  ]);
  const fromNumber = piped(`${NS}.Number`, [
    filter(parsesToADate('new Date(v)'), 'a date the runtime can parse'),
  ]);
  const union = `${NS}.Union(${plain}, ${fromString}, ${fromNumber})`;
  if (coerceDates === 'all') return union;
  return mode === 'select' ? plain : union;
}

/**
 * A character or byte cap, as a code-point predicate.
 *
 * Not `Schema.maxLength`. That counts UTF-16 code units, and both Postgres and MySQL count a
 * `varchar(n)` in characters, so ten thumbs-up characters are a valid row in a `varchar(10)` and
 * `maxLength(10)` refuses it, measured. `[...v].length` counts code points, which is what the
 * database counts. MySQL's TEXT family is a byte budget instead, carried separately as `maxBytes`,
 * and no keyword counts that either.
 *
 * Effect pays less for this than TypeBox does. A `Schema.filter` is an ordinary member of a pipe,
 * so the cap sits on the field where it belongs rather than being intersected onto the object, and
 * the schema stays a `Schema.String` that every other string combinator still composes with. What
 * it costs is the same thing it costs everywhere: the constraint does not survive to a JSON Schema
 * through `effect/JSONSchema`, which drops a filter carrying no `jsonSchema` annotation. Emitting a
 * number that means a different measurement in a form that serialises is not a better trade.
 */
function capSteps(c: Column, mode: Mode): string[] {
  const steps: string[] = [];
  if (c.shape?.kind === 'byteString') {
    const n = c.shape.length;
    if (!n) return steps;
    // Bytes going in and characters coming back out, on the same column: a MySQL `varbinary(n)`
    // holds n bytes and hands the caller a string.
    return mode === 'select'
      ? [filter(`${CODEPOINT_LENGTH} <= ${n}`, `at most ${n} characters`)]
      : [filter(`new TextEncoder().encode(v).length <= ${n}`, `at most ${n} bytes`)];
  }
  if (c.maxLength) {
    steps.push(
      filter(`${CODEPOINT_LENGTH} <= ${c.maxLength}`, `at most ${c.maxLength} characters`)
    );
  }
  if (c.maxBytes) {
    steps.push(
      filter(`new TextEncoder().encode(v).length <= ${c.maxBytes}`, `at most ${c.maxBytes} bytes`)
    );
  }
  return steps;
}

/**
 * `CHECK (length(name) >= 3)` as a pipe step on the field.
 *
 * On the field rather than on the object, which is where TypeBox has to put it: a filter is an
 * ordinary pipe step here, so the constraint lives next to the value it constrains and a failure
 * names the column. Placed before the nullable wrapper, so `null` skips it exactly as SQL does,
 * where a CHECK passes when it evaluates to TRUE **or NULL**.
 *
 * Code points, for the reason `capSteps` gives: SQL's `length()` counts characters.
 */
function lengthSteps(c: Column, lengths: LengthCheck[]): string[] {
  return lengths
    .filter((k) => k.column === c.name)
    .flatMap((k) => {
      const measure = lengthMeasure(c, k);
      if (!measure) return [];
      return [
        filter(
          `${measureExpression(measure, 'v')} ${OPS[k.operator]} ${k.value}`,
          lengthCheckLabel(k)
        ),
      ];
    });
}

/**
 * `CHECK (cardinality(tags) >= 2)` as a pipe step on the array.
 *
 * Only for an array column: on anything else there is nothing to count, and comparing the `.length`
 * of a string would enforce a different constraint than the schema stated. This is the one check an
 * array column does take, since it is about the array rather than about an element, so it is
 * applied after the array wrapping rather than before it.
 */
function cardinalitySteps(c: Column, cardinalities: CardinalityCheck[]): string[] {
  if (!c.arrayDimensions) return [];
  return cardinalities
    .filter((k) => k.column === c.name)
    .map((k) =>
      filter(
        `v.length ${OPS[k.operator]} ${k.value}`,
        `${k.name ? `${k.name}: ` : ''}cardinality(${c.name}) ${k.operator} ${k.value}`
      )
    );
}

/**
 * The CHECK constraints on this column that the bounds did not already state.
 *
 * An equality and an inequality are what is left, plus every check on a string column. Effect
 * carries all of them, which is one place it can say more than TypeBox: `<>` has no JSON Schema
 * keyword at all, so the TypeBox generator leaves it unstated rather than approximating it, and a
 * predicate states it exactly.
 */
function checkSteps(c: Column, checks: ColumnCheck[]): string[] {
  // A parsed check compares this column to a scalar literal, which says nothing usable about an
  // array or a tuple. Applied anyway, `CHECK (tags = 'x')` collapsed the whole column to one
  // literal and the schema rejected every row.
  if (c.arrayDimensions || c.shape) return [];
  const folded = foldedIntoBounds(c, checks);
  return checks
    .filter((k) => k.column === c.name && !folded.has(k))
    .map((k) => {
      // The wire-type spelling matters for `<>`, which is compared with strict equality:
      // `v !== 1` is true of every `1n`, so the constraint silently never fired on a bigint
      // column. The message keeps the SQL spelling either way.
      const literal = k.kind === 'string' ? JSON.stringify(k.value) : wireNumberLiteral(c, k.value);
      return filter(
        `v ${OPS[k.operator]} ${literal}`,
        `${k.name ? `${k.name}: ` : ''}${c.name} ${k.operator} ${k.value}`
      );
    });
}

/**
 * Whether this column has a runtime type worth checking at all.
 *
 * A json column, a `customType` one, an `any` one and one the analyzer could not name are the four
 * cases where `typedJson` *replaces* the schema rather than narrowing it, because the type Drizzle
 * inferred is strictly better than "any JSON" and there is nothing underneath worth keeping. The
 * predicate is shared with the import decision below: it decided those separately once, and the
 * emitted module then named `DrzlJsonValue` while the preamble that defines it had been suppressed,
 * which is a module that does not compile.
 */
function hasNoRuntimeType(c: Column): boolean {
  return c.tsType === 'any' || c.shape?.kind === 'custom' || c.shape?.kind === 'json';
}

/**
 * A column whose value is structured rather than scalar.
 *
 * These would otherwise land on `Schema.Unknown`, or for the tuple types on `Schema.String`, which
 * rejects every row: a `point` really arrives as `[number, number]`.
 */
function shapeExpr(c: Column, mode: Mode, replaced = false): string | undefined {
  const s = c.shape;
  if (!s) return undefined;
  switch (s.kind) {
    case 'json':
      // `typedJson` wins, since the inferred type is narrower than "any JSON". The recursive
      // preamble is then not emitted at all, so naming it here would name an undefined identifier.
      return replaced ? UNKNOWN_EXPR : JSON_CONST;
    case 'custom':
      // Nothing to check at runtime. `getSQLType()` gives the database side, and `fromDriver` may
      // map it to anything, so guessing would reject the real value.
      return UNKNOWN_EXPR;
    case 'buffer':
      return `${NS}.Uint8ArrayFromSelf`;
    case 'tuple':
      return `${NS}.Tuple(${Array.from({ length: s.length }, () => `${NS}.Number`).join(', ')})`;
    case 'numberObject':
      // The object modes of the same columns: `point({ mode: 'xy' })` returns `{ x, y }` and
      // `line({ mode: 'abc' })` returns `{ a, b, c }`. No exactness, because the column ignores an
      // unlisted key: measured on PGlite through drizzle 0.45.2, `{ x: 1, y: 2, z: 3 }` inserts and
      // the row stores `(1,2)`.
      return `${NS}.Struct({ ${s.fields.map((f) => `${f}: ${NS}.Number`).join(', ')} })`;
    case 'numberVector':
      return piped(
        `${NS}.Array(${NS}.Number)`,
        s.length ? [filter(`v.length === ${s.length}`, `exactly ${s.length} elements`)] : []
      );
    case 'bitstring':
      // Both bounds for a Postgres `bit(n)`, only the ceiling for a Cockroach `varbit(n)`, which
      // is why the empty string has to keep passing on the varying form.
      return piped(`${NS}.String`, [
        `${NS}.pattern(/^[01]*$/)`,
        ...(s.length
          ? [
              s.exact
                ? filter(`v.length === ${s.length}`, `exactly ${s.length} binary digits`)
                : filter(`v.length <= ${s.length}`, `at most ${s.length} binary digits`),
            ]
          : []),
      ]);
    case 'byteString':
      // A MySQL/SingleStore binary column takes any bytes at all and hands them back as a string,
      // so no pattern belongs here. The width is bytes in and code points out; see `capSteps`.
      return piped(`${NS}.String`, capSteps(c, mode));
  }
}

/**
 * The schema for one column's value, before nullability, arrays and optionality wrap it.
 */
function exprForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[],
  sets: ColumnSet[],
  lengths: LengthCheck[],
  replaced: boolean
): string {
  const shaped = shapeExpr(c, mode, replaced);
  // A shaped column takes no scalar comparison, but a `bytea` does take a byte count, which is the
  // one clause `lengthMeasure` answers on a shape. Piped on here rather than folded into
  // `shapeExpr`, which describes the column and knows nothing about its constraints.
  if (shaped) return piped(shaped, lengthSteps(c, lengths));

  // `CHECK (status IN ('a', 'b'))` is a union of literals, which effect spells as one call.
  //
  // A number-kind member is spelled in the column's wire type: effect compares a literal with
  // strict equality, so `Schema.Literal(1)` on a `bigint({ mode: 'bigint' })` column refused every
  // `1n` the driver returns and the select schema rejected every row. `wireNumberLiteral` decides
  // the spelling, and it also keeps a 64 bit member exact rather than rounding it.
  const set = sets.find((x) => x.column === c.name);
  if (set) {
    const values = set.values.map((v) =>
      set.kind === 'string' ? JSON.stringify(v) : wireNumberLiteral(c, v)
    );
    return `${NS}.Literal(${values.join(', ')})`;
  }
  // A parsed check compares the column against a scalar literal, which describes an element rather
  // than the array. Applied anyway, `CHECK (tags = 'x')` collapsed the whole column to a literal.
  if (c.arrayDimensions) checks = [];
  if (c.enumValues && c.enumValues.length) {
    return `${NS}.Literal(${c.enumValues.map((v) => JSON.stringify(v)).join(', ')})`;
  }

  // An equality pins the value outright, so it supersedes every other constraint on the column.
  // Spelled in the wire type for the same reason the set above is.
  const eq = checks.find((k) => k.column === c.name && k.operator === '=');
  if (eq && !c.shape) {
    return `${NS}.Literal(${eq.kind === 'string' ? JSON.stringify(eq.value) : wireNumberLiteral(c, eq.value)})`;
  }

  const rest = [...checkSteps(c, checks), ...lengthSteps(c, lengths)];

  switch (c.tsType) {
    case 'string': {
      // A constraint for any format the database enforces. `Schema.UUID` agrees with the pattern
      // the other generators carry on every probe, including the nil uuid and an uppercase one,
      // so the built-in is used rather than a hand-written copy of it.
      const base = c.format === 'uuid' ? `${NS}.UUID` : `${NS}.String`;
      const pattern =
        c.format && c.format !== 'uuid' && COLUMN_FORMATS[c.format]
          ? [`${NS}.pattern(new RegExp(${JSON.stringify(COLUMN_FORMATS[c.format])}))`]
          : [];
      return piped(base, [...pattern, ...capSteps(c, mode), ...rest]);
    }
    case 'number': {
      // `Schema.Finite` and not `Schema.Number`: see `withNonFinite` for why the constraint is
      // emitted rather than inherited, and why a range is not a substitute for it.
      const base = isIntegerColumn(c) ? `${NS}.Int` : `${NS}.Finite`;
      return withNonFinite(c, piped(base, [...numericBounds(c, checks), ...rest]));
    }
    case 'bigint':
      // The `n` suffix keeps a 64 bit bound exact. Written as a plain number it would round the
      // moment it was parsed: 9223372036854775807 becomes 9223372036854775808.
      return piped(`${NS}.BigIntFromSelf`, [
        ...(c.min !== undefined ? [`${NS}.greaterThanOrEqualToBigInt(${c.min}n)`] : []),
        ...(c.max !== undefined ? [`${NS}.lessThanOrEqualToBigInt(${c.max}n)`] : []),
        ...rest,
      ]);
    case 'boolean':
      return `${NS}.Boolean`;
    case 'Date':
      return dateExpr(mode, coerceDates);
    case 'Uint8Array':
      return `${NS}.Uint8ArrayFromSelf`;
    case 'any':
      return UNKNOWN_EXPR;
    default:
      // A column the analyzer could not type. Nothing is claimed about it rather than something
      // wrong being claimed; `drzl doctor` is where it is reported.
      return UNKNOWN_EXPR;
  }
}

/** One `"name": schema,` line of a Struct. */
function renderField(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[],
  sets: ColumnSet[],
  lengths: LengthCheck[],
  cardinalities: CardinalityCheck[],
  applyDefault: boolean,
  narrowRef?: string,
  /** The nominal brand this column carries, or nothing. See `@drzl/validation-core`'s branding. */
  brand?: string
): string {
  // A reference over a column with no runtime type replaces the schema; over any other column it
  // narrows one that keeps running.
  let expr = exprForColumn(
    c,
    mode,
    coerceDates,
    checks,
    sets,
    lengths,
    !!narrowRef && hasNoRuntimeType(c)
  );

  // Drizzle keeps an array on the element's own column class, so everything above describes the
  // element and the wrapping belongs out here, after its own constraints are attached. The length
  // bound belongs on the outermost array, which is the one `cardinality()` counts.
  const dims = c.arrayDimensions ?? 0;
  for (let i = 0; i < dims; i++) {
    expr = `${NS}.Array(${expr})`;
    if (i === dims - 1) expr = piped(expr, cardinalitySteps(c, cardinalities));
  }

  // Nullability wraps the constrained type, so null skips the constraint. That reproduces SQL,
  // where a CHECK passes when it evaluates to TRUE or NULL.
  //
  // Except over an unknown, where the union adds nothing: `Schema.Unknown` already accepts `null`,
  // and where a cast has narrowed the static type that type comes from Drizzle's own inference,
  // which spells a nullable column `T | null` on its own. The test is on the expression rather
  // than on the column, because an array of unknowns is not one and still needs the null arm.
  // Inside `NullOr`, and that placement is the whole of the decision. A brand is an intersection
  // and `null & { ... }` is `never`, so branding a schema that already admits null deletes the
  // null arm from the inferred type while decoding keeps accepting it. This order infers
  // `(number & Brand<'users.id'>) | null`, which is what the column is.
  if (brand) expr = piped(expr, [`${NS}.brand(${JSON.stringify(brand)})`]);

  if (c.nullable && !isUnknownExpr(expr)) expr = `${NS}.NullOr(${expr})`;

  // Not on a branded column. Both narrow the same column's static type and whichever runs last
  // wins, so they cannot both apply; see the zod generator for the full reasoning.
  if (narrowRef && !brand) expr = withNarrowedType(expr, narrowRef);

  if (mode === 'select') return expr;

  // A literal default is reproduced by `optionalWith`, which both makes the key optional and fills
  // the value in on decode. That is the behaviour `applyDefaults` documents: `parse({})` on a table
  // with `country: text().default('GB')` yields `{ country: 'GB' }`. It is off by default because
  // it changes what parsing *returns*, not only what it accepts.
  //
  // Only on insert. On update an absent key means "do not touch this column", so filling a default
  // in would write a value the caller never asked for.
  const wantsDefault = mode === 'insert' && applyDefault && c.defaultValue !== undefined;
  if (wantsDefault) {
    return `${NS}.optionalWith(${expr}, { default: () => ${JSON.stringify(c.defaultValue)} })`;
  }
  if (mode === 'update' || c.nullable || c.hasDefault) return `${NS}.optional(${expr})`;
  return expr;
}

/**
 * Whether this column takes a reference to the type Drizzle inferred.
 *
 * `typedJson` covers the columns with no runtime type; `typedColumns` covers every column. Shared
 * with the import decision below rather than restated there, because the two answers have to agree:
 * a file that emits no reference and still imports the schema module fails `noUnusedLocals` in the
 * consumer's build, and one that emits a reference without the import does not compile at all.
 */
function wantsRef(c: Column, allColumns: boolean): boolean {
  return allColumns || hasNoRuntimeType(c);
}

function renderObjectShape(
  cols: Column[],
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[],
  sets: ColumnSet[],
  lengths: LengthCheck[],
  cardinalities: CardinalityCheck[],
  typedJson: { table: string; mode: 'insert' | 'select'; allColumns?: boolean } | undefined,
  applyDefaults: boolean,
  brands?: { plan: BrandPlan; tsName: string }
): string {
  return cols
    .map((c) => {
      const ref =
        typedJson && wantsRef(c, !!typedJson.allColumns)
          ? `(typeof ${typedJson.table}.$infer${typedJson.mode === 'insert' ? 'Insert' : 'Select'})[${JSON.stringify(c.name)}]`
          : undefined;
      const field = renderField(
        c,
        mode,
        coerceDates,
        checks,
        sets,
        lengths,
        cardinalities,
        applyDefaults,
        ref,
        brands?.plan.brandOf(brands.tsName, c.name)
      );
      return `  ${JSON.stringify(c.name)}: ${field},`;
    })
    .join('\n');
}

/**
 * Row-level CHECK constraints, as filters on the Struct.
 *
 * A comparison between two columns is a statement about the row, so neither column alone can carry
 * it. `Schema.filter` over a Struct is the ordinary form for that here, which is one thing Effect
 * makes cheaper than TypeBox: no registry entry, no intersection, and the properties keep being
 * checked because the filter is a step in the same pipe rather than a sibling branch.
 */
function rowSteps(rows: RowCheck[], cols: Column[]): string[] {
  const present = new Set(cols.map((c) => c.name));
  return (
    rows
      // A check naming a column this mode does not carry cannot be evaluated: an insert schema
      // omits generated columns, so the comparison would read undefined and always pass or fail.
      .filter((r) => present.has(r.left) && present.has(r.right))
      .map((r) => {
        const l = `o[${JSON.stringify(r.left)}]`;
        const rt = `o[${JSON.stringify(r.right)}]`;
        const msg = `${r.name ? `${r.name}: ` : ''}${r.left} ${r.operator} ${r.right}`;
        // Null on either side means SQL never applied the comparison, so neither does this.
        return `${NS}.filter((o) => ${l} == null || ${rt} == null || ${l} ${OPS[r.operator]} ${rt}, { description: ${JSON.stringify(msg)} })`;
      })
  );
}

/** Push a rendered block one level deeper, so the nested object reads as one. */
function indentBlock(code: string, by = '  '): string {
  return code
    .split('\n')
    .map((line) => (line ? by + line : line))
    .join('\n');
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

/** The columns one node of a plan contributes, in the mode it is rendered for. */
function nestedNodeCols(node: NestedNode, mode: NestedMode): Column[] {
  const all = mode === 'insert' ? insertColumns(node.table) : selectColumns(node.table);
  return nestedNodeColumns(all, node);
}

/** Every node of a plan, so the preamble decisions can see the whole of what will be emitted. */
function nestedNodes(node: NestedNode, into: NestedNode[] = []): NestedNode[] {
  into.push(node);
  for (const arm of node.arms) nestedNodes(arm.child, into);
  return into;
}

/** One object of a nested payload, with its relations expanded inline. */
function renderNestedObject(
  node: NestedNode,
  mode: NestedMode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  typedJson: { allColumns?: boolean } | undefined,
  applyDefaults: boolean,
  brands?: BrandPlan
): string {
  const cols = nestedNodeCols(node, mode);
  const { checks, sets, rows, lengths, cardinalities } = parsedChecksFor(node.table);
  const tj = typedJson
    ? { table: node.table.tsName, mode, allColumns: typedJson.allColumns }
    : undefined;
  const fields = renderObjectShape(
    cols,
    mode,
    coerceDates,
    checks,
    sets,
    lengths,
    cardinalities,
    tj,
    applyDefaults,
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
      brands
    );
    // A to-one may come back null: a relational query returns null where there is no matching row,
    // and accepting it never turns away something the query produced. Optional throughout, because
    // which relations a payload carries is the caller's choice on a write and the `with` clause's
    // on a read.
    const inner = arm.single
      ? `${NS}.NullOr(\n${indentBlock(indentBlock(child))}\n  )`
      : `${NS}.Array(\n${indentBlock(indentBlock(child))}\n  )`;
    return `${notes}  ${JSON.stringify(arm.key)}: ${NS}.optional(${inner}),`;
  });

  const body = [fields, ...arms].filter(Boolean).join('\n');
  return piped(`${NS}.Struct({\n${body}\n})`, rowSteps(rows, cols));
}

/** The nested exports for one table, or nothing when it has no relations to describe. */
function renderNestedSchemas(
  table: Table,
  affix: ResolvedAffix,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  typedJson: { allColumns?: boolean } | undefined,
  applyDefaults: boolean,
  plans: Partial<Record<NestedMode, NestedNode>>,
  brands?: BrandPlan
): string {
  const out: string[] = [];
  for (const mode of ['insert', 'select'] as const) {
    const plan = plans[mode];
    if (!plan) continue;
    const name = nestedSchemaName(mode, table.tsName, affix);
    const tname = nestedTypeName(mode, table.tsName, affix);
    const expr = renderNestedObject(plan, mode, coerceDates, typedJson, applyDefaults, brands);
    out.push(
      `export const ${name} = ${expr};\n\n` +
        `export type ${tname} = ${NS}.Schema.Type<typeof ${name}>;\n\n` +
        `export const ${STANDARD_PREFIX}${name} = ${NS}.standardSchemaV1(${name});`
    );
  }
  return out.length ? `\n${out.join('\n\n')}\n` : '';
}

/**
 * The nested plans for one table, built once per mode.
 *
 * Returned as a partial map because the two modes disagree per table: a table that is only ever a
 * child has a nested select and no nested insert, and emitting an insert one anyway would put a
 * byte-for-byte copy of the plain insert schema in the file under a second name.
 */
function nestedPlansFor(
  table: Table,
  analysis: Analysis,
  depth: number
): Partial<Record<NestedMode, NestedNode>> {
  const out: Partial<Record<NestedMode, NestedNode>> = {};
  for (const mode of ['insert', 'select'] as const) {
    // A read-only relation refuses every write, so it has no insert schema to nest into.
    if (mode === 'insert' && (table as { readOnly?: boolean }).readOnly) continue;
    const plan = buildNestedPlan(table, analysis.tables, analysis.relations ?? [], mode, depth);
    if (plan) out[mode] = plan;
  }
  return out;
}

function renderTableSchemas(
  table: Table,
  affix: ResolvedAffix,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  typedJson?: { schemaSpecifier: string; allColumns?: boolean },
  applyDefaults = false,
  wantsDuplicateFinder = false,
  nested: Partial<Record<NestedMode, NestedNode>> = {},
  brands?: BrandPlan
) {
  const T = table.tsName;
  const insertCols = insertColumns(table);
  const updateCols = updateColumns(table);
  const selectCols = selectColumns(table);
  const { checks, sets, rows, lengths, cardinalities } = parsedChecksFor(table);

  const tj = typedJson ? { table: T, allColumns: typedJson.allColumns } : undefined;

  const modes = [
    ['insert', insertCols],
    ['update', updateCols],
    ['select', selectCols],
  ] as Array<[Mode, Column[]]>;

  const blocks = modes.map(([mode, cols]) => {
    const name = schemaName(mode, T, affix);
    const tname = typeName(mode, T, affix);
    const body = renderObjectShape(
      cols,
      mode,
      coerceDates,
      checks,
      sets,
      lengths,
      cardinalities,
      // The update schema references the insert-side inferred types: both describe a value going
      // in, and `$inferSelect` would name the post-default type for a column a write may omit.
      tj ? { ...tj, mode: mode === 'select' ? 'select' : 'insert' } : undefined,
      applyDefaults,
      brands ? { plan: brands, tsName: T } : undefined
    );
    const expr = piped(`${NS}.Struct({\n${body}\n})`, rowSteps(rows, cols));
    return (
      `export const ${name} = ${expr};\n\n` +
      `export type ${tname} = ${NS}.Schema.Type<typeof ${name}>;\n\n` +
      // Both forms, always. The bare Struct is the composable one and the only one that keeps
      // `fields`, which `Schema.pick`, `Schema.omit` and a spread into a wider Struct all read.
      // The wrapper is the only one that carries a `~standard`, which is what a tRPC or oRPC route
      // requires; a bare Struct has none, measured. Neither substitutes for the other, and the
      // wrapper is one call whose cost was measured at 24 microseconds per thousand.
      `export const ${STANDARD_PREFIX}${name} = ${NS}.standardSchemaV1(${name});`
    );
  });

  // Every column the nested shapes will emit, alongside this table's own. The preamble is
  // conditional, so a json column reachable only through a relation would otherwise name
  // `DrzlJsonValue` and never define it, which is a compile error.
  const nestedByTable = (['insert', 'select'] as const).flatMap((m) => {
    const plan = nested[m];
    return plan
      ? nestedNodes(plan).map((n) => [n.table.tsName, nestedNodeCols(n, m)] as const)
      : [];
  });
  const nestedCols = nestedByTable.flatMap(([, cs]) => cs);

  // A nested shape references the columns of *other* tables, so those tables have to be named in
  // the import too, and only the ones that really take a reference: `noUnusedLocals` in the
  // consumer's build turns a spare name here into a compile error, which is how a `posts` table
  // with nothing to narrow was caught importing itself for no reason.
  const referenced = new Set<string>();
  if (typedJson) {
    const all = !!typedJson.allColumns;
    if ([...insertCols, ...updateCols, ...selectCols].some((c) => wantsRef(c, all))) {
      referenced.add(T);
    }
    for (const [name, cs] of nestedByTable) {
      if (cs.some((c) => wantsRef(c, all))) referenced.add(name);
    }
  }
  const schemaImport = referenced.size
    ? `import type { ${[...referenced].join(', ')} } from '${typedJson!.schemaSpecifier}';\n`
    : '';
  // Not emitted when `typedJson` has replaced every json column with the inferred type, so a file
  // never carries a declaration nothing uses; `noUnusedLocals` in the emitted-output typecheck is
  // what holds this honest.
  const needsJson =
    !typedJson &&
    [...insertCols, ...updateCols, ...selectCols, ...nestedCols].some(
      (c) => c.shape?.kind === 'json'
    );

  // Uniqueness is a fact about the table, so no per-row schema can see it. This checks the half
  // that needs no database: whether a batch collides with itself.
  const finder = wantsDuplicateFinder
    ? renderDuplicateFinder(table, `findDuplicate${T}`, typeName('insert', T, affix))
    : undefined;
  const duplicates = finder ? `\n${finder}\n` : '';

  const nestedCode = renderNestedSchemas(
    table,
    affix,
    coerceDates,
    typedJson,
    applyDefaults,
    nested,
    brands
  );

  // The brand read back off the schema that carries it, rather than written out a second time.
  const selectName = schemaName('select', T, affix);
  const brandAliases = (brands?.aliasesFor(T) ?? [])
    .map(
      (a) =>
        `/** The nominal type of ${T}.${a.column}. */\n` +
        `export type ${a.alias} = ${NS}.Schema.Type<typeof ${selectName}>[${JSON.stringify(a.column)}];`
    )
    .join('\n\n');
  const brandCode = brandAliases ? `\n${brandAliases}\n` : '';

  return `import * as ${NS} from 'effect/Schema';
${schemaImport}${needsJson ? `\n${JSON_PREAMBLE}` : ''}
${blocks.join('\n\n')}
${brandCode}${nestedCode}${duplicates}`;
}

export interface EffectGenerateOptions extends ValidationGenerateOptions {
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
}

export class EffectGenerator implements ValidationRenderer<EffectGenerateOptions> {
  readonly library = 'effect' as const;
  constructor(private analysis: Analysis) {}

  async generate(opts: EffectGenerateOptions) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outDir);
    const files: string[] = [];
    await fs.mkdir(out, { recursive: true });
    const affix = resolveAffix(opts);
    const coerceDates = opts.coerceDates ?? 'input';
    const fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;

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
    // Built once for the whole analysis, because a foreign key is branded after the table it
    // points at and no single table knows that.
    const brands = buildBrandPlan(this.analysis.tables, opts.branded);
    for (const note of brands?.notes ?? []) console.warn(`[drzl] ${note}`);
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

    const indexPath = path.join(out, 'index.ts');
    const indexFormatted = await formatCode(
      buildHeader(opts.outputHeader) + this.defaultIndex(this.analysis, opts),
      indexPath,
      opts.format
    );
    await fs.writeFile(indexPath, indexFormatted, 'utf8');
    files.push(indexPath);
    return files;
  }

  renderTable(table: Table, opts?: EffectGenerateOptions) {
    return renderTableSchemas(
      table,
      resolveAffix(opts),
      opts?.coerceDates ?? 'input',
      undefined,
      !!opts?.applyDefaults,
      !!opts?.duplicateFinder,
      {},
      buildBrandPlan(this.analysis.tables, opts?.branded)
    );
  }

  private defaultIndex(analysis: Analysis, opts: EffectGenerateOptions) {
    const fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;
    return (
      analysis.tables
        .map(
          (t) => `export * from '${moduleSpecifier(t.tsName, fileSuffix, opts.importExtension)}';`
        )
        .join('\n') + '\n'
    );
  }
}

export default EffectGenerator;

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
