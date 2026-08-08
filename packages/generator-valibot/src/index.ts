import type { Analysis, Table, Column } from '@drzl/analyzer';
import type {
  ResolvedAffix,
  ValidationRenderer,
  ValidationGenerateOptions,
  RowCheck,
} from '@drzl/validation-core';
import type { CardinalityCheck, ColumnCheck, ColumnSet, LengthCheck } from '@drzl/validation-core';
import type { NestedMode, NestedNode } from '@drzl/validation-core';
import type { BrandPlan, ConstraintsOption } from '@drzl/validation-core';
import {
  applyWirePolicy,
  buildBrandPlan,
  buildNestedPlan,
  canonicalMembers,
  canonicalNumericText,
  comparisonWire,
  describeSet,
  needsNumericCanon,
  COERCIBLE_DATE_STRING,
  COLUMN_FORMATS,
  CONSTRAINTS_MODULE,
  NUMERIC_CANON_NAME,
  NUMERIC_CANON_SOURCE,
  importSpecifier,
  insertColumns,
  isIntegerColumn,
  lengthCheckLabel,
  lengthMeasure,
  measureExpression,
  nestedArmNotes,
  nestedNodeColumns,
  nestedSchemaName,
  nestedTypeName,
  nonFiniteAccepted,
  parseCheck,
  parsesToADate,
  renderConstraintsModule,
  renderDuplicateFinder,
  resolveConfiguredImport,
  resolveConstraints,
  resolveNestedDepth,
  updateColumns,
  selectColumns,
  formatCode,
  moduleFileName,
  moduleSpecifier,
  resolveAffix,
  schemaName,
  typeName,
  wireNumberLiteral,
} from '@drzl/validation-core';

type Mode = 'insert' | 'update' | 'select';

/**
 * Suffix appended to the Drizzle export name for every emitted file. The barrel derives
 * its import specifiers from whatever value wins here, so overriding it with `fileSuffix`
 * renames the files and the exports together.
 */
const DEFAULT_FILE_SUFFIX = '.valibot.ts';

function vDateExpr(
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
): string {
  if (coerceDates === 'none') return 'v.date()';
  // Not every string, and the pipe says so twice, because those are two different questions.
  //
  // The regex is the gate on the string. `new Date` reads a bare number as a year or as month.day,
  // so `'12.5'`, `'0101'` and `'010'` all became real dates here and Postgres refuses all three;
  // see `COERCIBLE_DATE_STRING` for what was measured and why. It runs before the transform, so
  // such a string never reaches `new Date` at all.
  //
  // The check is the gate on the result, and without it any string the regex let through was
  // accepted whatever came out: `'hello'`, `'zzz'` and `'25:99:99'` are not bare numbers, so they
  // passed the pattern, became an Invalid Date and were taken. A valibot action sees the previous
  // step's *output*, so this one is handed the `Date` rather than the string, and an Invalid Date
  // is a real `Date` instance whose only tell is `getTime()`; see `parsesToADate`.
  const coercer =
    `v.pipe(v.string(), v.regex(new RegExp(${JSON.stringify(COERCIBLE_DATE_STRING)})), ` +
    `v.transform((s) => new Date(s)), ` +
    `v.check((d) => ${parsesToADate('d')}, 'a date the runtime can parse'))`;
  // An epoch number, which `coerceDates` documents beside the string and which only the zod
  // generator ever accepted. `Date.now()` went into a zod schema and bounced off the other three,
  // so the same table validated differently depending on which validator you had chosen.
  //
  // No pattern here, because there is no notation to be wrong about: a number is milliseconds
  // since the epoch and nothing else, which is why the string's regex has no counterpart on this
  // branch.
  //
  // The result check does have one, and it is not redundant. `v.number()` refuses `NaN` on its own
  // and takes both infinities, measured, so `Infinity` would otherwise reach `new Date` and come
  // back an Invalid Date. Finite is not enough either: the `Date` range ends at +-8.64e15, so
  // `1e300` is a perfectly good number and not a date. One check answers all three.
  const fromNumber =
    `v.pipe(v.number(), v.transform((n) => new Date(n)), ` +
    `v.check((d) => ${parsesToADate('d')}, 'a date the runtime can parse'))`;
  const coerced = `v.union([v.date(), ${coercer}, ${fromNumber}])`;
  if (coerceDates === 'all') return coerced;
  // 'input'
  return mode === 'select' ? 'v.date()' : coerced;
}

/**
 * `v.minValue(min), v.maxValue(max)` for a column declaring an integer range, else nothing.
 *
 * Bounds arrive as decimal strings, since a 64 bit bound cannot round-trip through a JS number,
 * so they are pasted rather than parsed. `literal` spells each one, which is the only difference
 * between the number and bigint cases.
 */
function vBounds(c: Column, literal: (v: string) => string, checks: ColumnCheck[] = []): string[] {
  let lo = c.min !== undefined ? { action: 'minValue', value: c.min } : undefined;
  let hi = c.max !== undefined ? { action: 'maxValue', value: c.max } : undefined;

  // A CHECK replaces the end it narrows rather than sitting beside it. It cannot widen: the
  // declared range is the column's type, and no CHECK makes an int32 hold more.
  //
  // valibot has the exclusive forms natively, so `> 0` is `v.gtValue(0)` rather than a closure,
  // and the issue it raises carries `requirement: 0` as data instead of as a sentence this
  // generator wrote.
  for (const k of checks.filter((x) => x.column === c.name && x.kind === 'number')) {
    if (k.operator === '>=') lo = { action: 'minValue', value: k.value };
    else if (k.operator === '>') lo = { action: 'gtValue', value: k.value };
    else if (k.operator === '<=') hi = { action: 'maxValue', value: k.value };
    else if (k.operator === '<') hi = { action: 'ltValue', value: k.value };
  }

  return [lo, hi].filter(Boolean).map((x) => `v.${x!.action}(${literal(x!.value)})`);
}

/**
 * The union branches for the non-finite doubles this column really stores, or none.
 *
 * A union rather than a wider range, because no range can hold either value: `v.maxValue(n)`
 * refuses `Infinity` whatever `n` is, and `NaN` compares false against both ends.
 *
 * `bounded` is why this is not the same list zod and TypeBox emit. Measured on the installed
 * valibot: a bare `v.number()` already accepts `Infinity` and `-Infinity` and refuses only `NaN`,
 * so an unbounded `double precision` needs one branch where a bounded `real` needs three. Emitting
 * the redundant pair anyway would put two branches in the generated file that change nothing, and
 * the measurement is asserted in this package's non-finite spec rather than trusted.
 *
 * Both infinity branches together once any bound is present, rather than one per side. For the
 * three Postgres columns this reaches, the type's own bounds always come as a pair; a lone bound
 * can only arrive from a CHECK, and the branch that is then redundant admits nothing new.
 */
function vNonFiniteBranches(c: Column, bounded: boolean): string[] {
  const { nan, infinity } = nonFiniteAccepted(c);
  return [
    ...(nan ? ['v.nan()'] : []),
    ...(infinity && bounded ? ['v.literal(Infinity)', 'v.literal(-Infinity)'] : []),
  ];
}

/** Which checks `vBounds` has already stated, so they are not also emitted as actions. */
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
 * `v.check(...)` actions for the CHECK constraints naming this column.
 *
 * Same contract as the Zod generator: only comparisons the shared parser understands with
 * certainty, and placed on the inner schema so `v.nullable()` wrapping it reproduces SQL's rule
 * that a CHECK passes on TRUE or NULL.
 */
function vChecks(c: Column, checks: ColumnCheck[]): string[] {
  // A parsed check compares this column against a scalar literal, which says nothing usable
  // about an array or a tuple: `CHECK (tags = '{}')` would become a check no `string[]` can
  // satisfy, rejecting every row.
  if (c.arrayDimensions || c.shape) return [];

  const OPS: Record<ColumnCheck['operator'], string> = {
    '>=': '>=',
    '>': '>',
    '<=': '<=',
    '<': '<',
    '=': '===',
    '<>': '!==',
  };
  const folded = foldedIntoBounds(c, checks);
  const numericWire = comparisonWire(c) === 'numeric-string';
  return checks
    .filter((k) => k.column === c.name && !folded.has(k))
    .map((k) => {
      const shown = k.kind === 'string' ? `'${k.value}'` : k.value;
      const msg = JSON.stringify(`${k.name ? `${k.name}: ` : ''}${c.name} ${k.operator} ${shown}`);
      // On a numeric string wire the driver spells one value many ways ('1', '1.00') and the
      // database compares them as numbers, so `val === 1` was false for every returned row and
      // `val !== 1` enforced nothing. Equality goes through the canonical spelling; a range
      // keeps its coerced numeric compare, spelled `Number(val)` so the comparison it always
      // performed is visible and the module typechecks. See the zod generator and
      // `wireLiteralFit`.
      if (numericWire) {
        if (k.operator === '=' || k.operator === '<>') {
          const canon = JSON.stringify(canonicalNumericText(k.value));
          const op = k.operator === '=' ? '===' : '!==';
          return `v.check((val) => ${NUMERIC_CANON_NAME}(val) ${op} ${canon}, ${msg})`;
        }
        return `v.check((val) => Number(val) ${OPS[k.operator]} ${k.value}, ${msg})`;
      }
      // Strict equality for `=` and `<>` demands the wire type: `val === 1` is false for every
      // `1n` a bigint-mode column returns. The message keeps the SQL spelling either way.
      const rhs = k.kind === 'string' ? JSON.stringify(k.value) : wireNumberLiteral(c, k.value);
      return `v.check((val) => val ${OPS[k.operator]} ${rhs}, ${msg})`;
    });
}

/** Name of the recursive JSON schema emitted into a file that has any json column. */
const JSON_CONST = 'DrzlJsonValue';

/**
 * A recursive definition of the JSON value space, emitted once per file.
 *
 * Valibot has no `json()` built-in, and `v.any()` accepted `undefined`, `NaN`, bigints and every
 * class instance, none of which survive the round trip through a json column. The shape mirrors
 * what `drizzle-orm/valibot` builds, with one addition: `v.finite()`, so `Infinity` is rejected
 * rather than written out as `null`.
 */
const JSON_PREAMBLE = `type ${JSON_CONST}Type =
  | string
  | number
  | boolean
  | null
  | ${JSON_CONST}Type[]
  | { [key: string]: ${JSON_CONST}Type };

const ${JSON_CONST}: v.GenericSchema<${JSON_CONST}Type> = v.lazy(() =>
  v.union([
    v.string(),
    v.pipe(v.number(), v.finite()),
    v.boolean(),
    v.null(),
    v.array(${JSON_CONST}),
    v.pipe(
      // The plain-object test comes before the record, not after it. A valibot pipe passes the
      // *output* of each step onward, and \`v.record\` outputs a freshly built object, so a check
      // placed after it inspects that new object and reports every input as plain. A Date sailed
      // through: it has no own enumerable keys, so the record accepted it and rebuilt it as \`{}\`.
      v.custom<Record<string, ${JSON_CONST}Type>>((o) => {
        if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
        const p = Object.getPrototypeOf(o);
        return p === Object.prototype || p === null;
      }, 'not a plain object'),
      v.record(v.string(), ${JSON_CONST})
    ),
  ])
);
`;

/**
 * A column whose value is structured rather than scalar.
 *
 * These used to fall through to `v.any()`/`v.unknown()`, or for the tuple types to `v.string()`,
 * which rejected every row since a `point` really arrives as `[number, number]`.
 */
function vShapeExpr(c: Column, mode: Mode): string | undefined {
  const s = c.shape;
  if (!s) return undefined;
  switch (s.kind) {
    case 'json':
      return JSON_CONST;
    case 'custom':
      // A `customType` column carries no runtime information: `fromDriver` may map its SQL type
      // to anything, so guessing from `getSQLType()` would reject the real value.
      return 'v.unknown()';
    case 'buffer':
      // Matches the SQLite blob mapping, so binary validates the same way in either dialect.
      return 'v.instance(Uint8Array)';
    case 'tuple':
      // `strictTuple`, not `tuple`: valibot's plain `tuple` ignores extra items, so a `point`
      // schema built from it accepted `[1, 2, 3]`.
      return `v.strictTuple([${Array.from({ length: s.length }, () => 'v.number()').join(', ')}])`;
    case 'numberObject':
      // The object modes of the same columns: `point({ mode: 'xy' })` returns `{ x, y }` and
      // `line({ mode: 'abc' })` returns `{ a, b, c }`.
      //
      // `v.object` and not `v.strictObject`, which is the opposite choice from the tuple above and
      // for the same reason: it follows the column. Measured on PGlite through drizzle 0.45.2,
      // `mapToDriverValue` reads the named fields and ignores the rest, so `{ x: 1, y: 2, z: 3 }`
      // inserts and stores `(1,2)` while `[1, 2, 3]` in a strict tuple's place is a value the
      // tuple column never produces.
      return `v.object({ ${s.fields.map((f) => `${f}: v.number()`).join(', ')} })`;
    case 'numberVector':
      return s.length
        ? `v.pipe(v.array(v.number()), v.length(${s.length}))`
        : 'v.array(v.number())';
    case 'bitstring': {
      // `v.length` for a Postgres `bit(n)`, `v.maxLength` for a Cockroach `varbit(n)`.
      const len = s.length
        ? `, ${s.exact ? `v.length(${s.length})` : `v.maxLength(${s.length})`}`
        : '';
      return `v.pipe(v.string(), v.regex(/^[01]*$/)${len})`;
    }
    case 'byteString': {
      // See the zod generator: a MySQL/SingleStore binary column takes any bytes at all and hands
      // them back as a string, and the declared width is code points out and bytes in. Not
      // `v.maxLength`, which counts UTF-16 units and so is neither.
      if (!s.length) return 'v.string()';
      const check =
        mode === 'select'
          ? `v.check((val) => [...val].length <= ${s.length}, 'at most ${s.length} characters')`
          : `v.check((val) => new TextEncoder().encode(val).length <= ${s.length}, 'at most ${s.length} bytes')`;
      return `v.pipe(v.string(), ${check})`;
    }
  }
}

/**
 * `v.check(...)` actions for the `length(col)` and `octet_length(col)` constraints naming this
 * column.
 *
 * Code points for a character count, because Postgres counts characters; the UTF-8 encoding for a
 * byte count on a string, and the array's own length for one on a `bytea`. See the zod generator,
 * and `lengthMeasure` for the one place that choice is made.
 */
function vLengthChecks(c: Column, lengths: LengthCheck[]): string[] {
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
    .flatMap((k) => {
      const measure = lengthMeasure(c, k);
      if (!measure) return [];
      const msg = JSON.stringify(lengthCheckLabel(k));
      const count = measureExpression(measure, 'val');
      return [`v.check((val) => ${count} ${OPS[k.operator]} ${k.value}, ${msg})`];
    });
}

/**
 * `v.check(...)` actions for the `cardinality(col)` constraints naming this column.
 *
 * Only for an array column, and applied to the array rather than to an element, which is why it
 * is threaded to the field rather than folded into the element pipe.
 */
function vCardinalityChecks(c: Column, cardinalities: CardinalityCheck[]): string[] {
  if (!c.arrayDimensions) return [];
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
      return `v.check((val) => val.length ${OPS[k.operator]} ${k.value}, ${msg})`;
    });
}

function vExprForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  sets: ColumnSet[] = [],
  lengths: LengthCheck[] = []
): string {
  const shaped = vShapeExpr(c, mode);
  if (shaped) {
    // A shaped column takes no scalar comparison, but a `bytea` does take a byte count, which is
    // the one clause `lengthMeasure` answers on a shape. Piped on here rather than folded into
    // `vShapeExpr`, which describes the column and knows nothing about its constraints.
    const shapeChecks = vLengthChecks(c, lengths);
    return shapeChecks.length ? `v.pipe(${shaped}, ${shapeChecks.join(', ')})` : shaped;
  }
  // `CHECK (status IN ('a', 'b'))` constrains the column to a set, which is what a picklist is.
  //
  // A number-kind member is spelled in the column's wire type: `v.literal(1)` on a
  // `bigint({ mode: 'bigint' })` column refused every `1n` the driver returns, so the select
  // schema rejected every row. `wireNumberLiteral` decides the spelling, and it also keeps a
  // 64 bit member exact: written as a number it rounds the moment it is parsed.
  const set = sets.find((x) => x.column === c.name);
  if (set) {
    // On a numeric string wire no list of literals can state the set: the driver spells one
    // admitted value many ways by declared scale ('1.00' for a stored 1, measured) and the
    // database admits them all. The compare runs over the canonical spelling instead, exact at
    // any precision where `Number()` rounds. See the zod generator and `wireLiteralFit`.
    if (comparisonWire(c) === 'numeric-string') {
      const members = canonicalMembers(set.values);
      const test = members.map((m) => `canon === ${JSON.stringify(m)}`).join(' || ');
      const msg = JSON.stringify(describeSet(set));
      return (
        `v.pipe(v.string(), v.check((val) => { const canon = ${NUMERIC_CANON_NAME}(val); ` +
        `return ${test}; }, ${msg}))`
      );
    }
    return set.kind === 'string'
      ? `v.picklist([${set.values.map((v) => JSON.stringify(v)).join(', ')}] as const)`
      : `v.union([${set.values.map((v) => `v.literal(${wireNumberLiteral(c, v)})`).join(', ')}])`;
  }
  const extra = [...vChecks(c, checks), ...vLengthChecks(c, lengths)];
  /** Fold the constraint actions into whatever base this column maps to. */
  const piped = (base: string, actions: string[]) => {
    const all = [...actions, ...extra];
    return all.length ? `v.pipe(${base}, ${all.join(', ')})` : base;
  };
  if (c.enumValues && c.enumValues.length) {
    const vals = c.enumValues.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(', ');
    // picklist is a common valibot helper for string enums
    return `v.picklist([${vals}] as const)`;
  }
  switch (c.tsType) {
    // Valibot composes constraints as pipeline actions rather than chained methods, so each of
    // these becomes `v.pipe(base, ...actions)` and stays a single expression.
    case 'string':
      if (c.format === 'uuid') return piped('v.string()', ['v.uuid()']);
      // See the zod generator: a bare string accepted values Postgres rejects.
      const pattern = c.format ? COLUMN_FORMATS[c.format] : undefined;
      if (pattern) return piped('v.string()', [`v.regex(new RegExp(${JSON.stringify(pattern)}))`]);
      // Not `v.maxLength(n)`, which counts UTF-16 units where the column counts characters. All
      // four generators count code points; see `CODEPOINT_LENGTH` in validation-core.
      // Two different measurements. `varchar(n)` counts characters in both databases; MySQL's
      // TEXT family counts bytes, so a tinytext takes 255 ascii characters and only 63 emoji.
      const caps: string[] = [];
      if (c.maxLength) {
        caps.push(
          `v.check((val) => [...val].length <= ${c.maxLength}, 'at most ${c.maxLength} characters')`
        );
      }
      if (c.maxBytes) {
        caps.push(
          `v.check((val) => new TextEncoder().encode(val).length <= ${c.maxBytes}, 'at most ${c.maxBytes} bytes')`
        );
      }
      return piped('v.string()', caps.length ? caps : []);
    case 'number': {
      const bounds = vBounds(c, (v) => v, checks);
      const actions = [...(isIntegerColumn(c) ? ['v.integer()'] : []), ...bounds];
      const branches = vNonFiniteBranches(c, bounds.length > 0);
      if (!branches.length) return piped('v.number()', actions);
      // The bounds stay on the number branch and the union is what `extra` then applies to, so a
      // CHECK that could not be folded into a bound still sees every value the column admits.
      const finite = actions.length ? `v.pipe(v.number(), ${actions.join(', ')})` : 'v.number()';
      return piped(`v.union([${finite}, ${branches.join(', ')}])`, []);
    }
    case 'bigint': {
      // Bounds must be bigint literals: a 64 bit bound written as a number rounds.
      return piped(
        'v.bigint()',
        vBounds(c, (v) => `${v}n`, checks)
      );
    }
    case 'boolean':
      return 'v.boolean()';
    case 'Date':
      return vDateExpr(mode, coerceDates);
    case 'Uint8Array':
      return 'v.instance(Uint8Array)';
    case 'any':
      return 'v.any()';
    default:
      return 'v.unknown()';
  }
}

/**
 * Narrow a field's static type to what Drizzle inferred, leaving the runtime schema untouched.
 *
 * Valibot has no `Type.Unsafe` equivalent, so this is an identity transform: the value passes
 * through unchanged and only `InferOutput` sees the narrower type. Appended last, after the
 * nullable and optional wrappers, so neither is disturbed.
 */
function vNarrow(expr: string, ref?: string): string {
  return ref ? `v.pipe(${expr}, v.transform((x) => x as ${ref}))` : expr;
}

function vField(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  sets: ColumnSet[] = [],
  applyDefault = false,
  lengths: LengthCheck[] = [],
  cardinalities: CardinalityCheck[] = [],
  narrowRef?: string,
  /** The nominal brand this column carries, or nothing. See `@drzl/validation-core`'s branding. */
  brand?: string
): string {
  let expr = vExprForColumn(c, mode, coerceDates, checks, sets, lengths);
  // Drizzle keeps an array on the element's own column class, so everything above describes the
  // element and the wrapping belongs out here, after the bounds and length limits are attached.
  for (let i = 0; i < (c.arrayDimensions ?? 0); i++) expr = `v.array(${expr})`;
  // After the wrapping, because this constrains the array rather than an element.
  const card = vCardinalityChecks(c, cardinalities);
  if (card.length) expr = `v.pipe(${expr}, ${card.join(', ')})`;
  // Inside `v.nullable`, and that placement is the whole of the decision. A brand is an
  // intersection and `null & { ... }` is `never`, so `v.pipe(v.nullable(x), v.brand('users.id'))`
  // infers `number & Brand<'users.id'>` with the null arm gone, measured on valibot 1.4.2, while
  // the schema still parses null. This order infers `(number & Brand<'users.id'>) | null`.
  //
  // Folded into the pipe the column already has rather than nesting a second one inside it.
  // `v.pipe(v.pipe(a, b), v.brand(x))` behaves identically, measured on 1.4.2, and reads like a
  // generator that lost track of what it had already emitted. The expression is one balanced
  // term, so when it opens with `v.pipe(` its last character is that call's own bracket.
  if (brand) {
    const action = `v.brand(${JSON.stringify(brand)})`;
    expr = expr.startsWith('v.pipe(')
      ? `${expr.slice(0, -1)}, ${action})`
      : `v.pipe(${expr}, ${action})`;
  }
  if (c.nullable) expr = `v.nullable(${expr})`;
  if (mode !== 'select') {
    // A literal default is reproduced as valibot's second argument to `optional`, which is where
    // it puts one. `v.optional(schema, value)` already makes the key optional, so this replaces
    // the plain wrapper rather than nesting inside it.
    if (mode === 'insert' && applyDefault && c.defaultValue !== undefined) {
      expr = `v.optional(${expr}, ${JSON.stringify(c.defaultValue)})`;
    } else if (mode === 'update' || c.nullable || c.hasDefault) {
      // optional for insert when nullable/hasDefault, and for all fields in update
      expr = `v.optional(${expr})`;
    }
  }
  // Not on a branded column. Both narrow the same column's static type and whichever runs last
  // wins, so they cannot both apply; see the zod generator for the full reasoning.
  return vNarrow(expr, brand ? undefined : narrowRef);
}

function renderObjectShape(
  cols: Column[],
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  sets: ColumnSet[] = [],
  applyDefaults = false,
  lengths: LengthCheck[] = [],
  cardinalities: CardinalityCheck[] = [],
  typedColumns?: { table: string; mode: 'insert' | 'select' },
  brands?: { plan: BrandPlan; tsName: string }
) {
  return cols
    .map(
      (c) =>
        `  ${JSON.stringify(c.name)}: ${vField(
          c,
          mode,
          coerceDates,
          checks,
          sets,
          applyDefaults,
          lengths,
          cardinalities,
          typedColumns
            ? `(typeof ${typedColumns.table}.$infer${typedColumns.mode === 'insert' ? 'Insert' : 'Select'})[${JSON.stringify(c.name)}]`
            : undefined,
          brands?.plan.brandOf(brands.tsName, c.name)
        )},`
    )
    .join('\n');
}

/**
 * `v.check(...)` actions that belong on the object rather than on a field.
 *
 * `CHECK (start_date < end_date)` is a statement about the row: neither column alone can say
 * whether it holds. Both sides are guarded for null first, reproducing SQL, where a comparison
 * involving NULL yields NULL and the CHECK passes.
 */
/** Wrap an object schema in its row-level checks, or leave it alone when there are none. */
function wrapRows(objectExpr: string, rows: RowCheck[], cols: Column[]): string {
  const checks = vRowChecks(rows, cols);
  return checks.length ? `v.pipe(${objectExpr}, ${checks.join(', ')})` : objectExpr;
}

function vRowChecks(rows: RowCheck[], cols: Column[]): string[] {
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
      // A check naming a column this mode does not carry cannot be evaluated: an insert schema
      // omits generated columns, so the comparison would read undefined and always pass or fail.
      .filter((r) => present.has(r.left) && present.has(r.right))
      .map((r) => {
        const l = `o[${JSON.stringify(r.left)}]`;
        const rt = `o[${JSON.stringify(r.right)}]`;
        const msg = JSON.stringify(
          `${r.name ? `${r.name}: ` : ''}${r.left} ${r.operator} ${r.right}`
        );
        return `v.check((o) => ${l} == null || ${rt} == null || ${l} ${OPS[r.operator]} ${rt}, ${msg})`;
      })
  );
}

/**
 * Every CHECK on a table that the shared parser understands, split by what it constrains.
 *
 * The wire policy runs here, exactly as in the zod generator: quoted literals the database
 * compares numerically come back respelled number-kind, and clauses no exact compare can state
 * are dropped, left to the base schema and reported by the constraint ledger.
 */
function parsedChecksFor(table: Table) {
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
 * Rendered from the columns rather than derived from the sibling schema with `v.omit`. Measured on
 * valibot 1.4.2: `v.omit` applied to the `v.pipe(v.object(...), v.check(...))` that a table with a
 * row-level CHECK emits returns a bare object schema and **drops the checks**, with no error. A
 * derived nested schema would therefore have silently stopped enforcing every row-level constraint
 * on the child.
 */
function renderNestedObject(
  node: NestedNode,
  mode: NestedMode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  applyDefaults: boolean,
  typedColumns: boolean,
  brands?: BrandPlan
): string {
  const all = mode === 'insert' ? insertColumns(node.table) : selectColumns(node.table);
  const cols = nestedNodeColumns(all, node);
  const { checks, sets, rows, lengths, cardinalities } = parsedChecksFor(node.table);
  const tc = typedColumns ? { table: node.table.tsName, mode } : undefined;
  const fields = renderObjectShape(
    cols,
    mode,
    coerceDates,
    checks,
    sets,
    applyDefaults,
    lengths,
    cardinalities,
    tc,
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
      applyDefaults,
      typedColumns,
      brands
    );
    // A to-one may come back null: a relational query returns null where there is no matching
    // row, and accepting it never turns away something the query produced. Optional throughout,
    // because which relations a payload carries is the caller's choice on a write and the `with`
    // clause's on a read.
    const inner = arm.single
      ? `v.nullable(\n${indentBlock(indentBlock(child))}\n  )`
      : `v.array(\n${indentBlock(indentBlock(child))}\n  )`;
    return `${notes}  ${JSON.stringify(arm.key)}: v.optional(${inner}),`;
  });

  const body = [fields, ...arms].filter(Boolean).join('\n');
  return wrapRows(`v.object({\n${body}\n})`, rows, cols);
}

/** The nested exports for one table, or nothing when it has no relations to describe. */
function renderNestedSchemas(
  table: Table,
  affix: ResolvedAffix,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  applyDefaults: boolean,
  typedColumns: boolean,
  plans: Partial<Record<NestedMode, NestedNode>>,
  brands?: BrandPlan
): string {
  const out: string[] = [];
  for (const mode of ['insert', 'select'] as const) {
    const plan = plans[mode];
    if (!plan) continue;
    const name = nestedSchemaName(mode, table.tsName, affix);
    const tname = nestedTypeName(mode, table.tsName, affix);
    const expr = renderNestedObject(plan, mode, coerceDates, applyDefaults, typedColumns, brands);
    const infer = mode === 'insert' ? 'InferInput' : 'InferOutput';
    out.push(`export const ${name} = ${expr};\n\nexport type ${tname} = ${infer}<typeof ${name}>;`);
  }
  return out.length ? `\n${out.join('\n\n')}\n` : '';
}

/** Every table a plan reaches, so a type-only import can name all of them. */
function nestedTables(node: NestedNode, into = new Set<string>()): Set<string> {
  into.add(node.table.tsName);
  for (const arm of node.arms) nestedTables(arm.child, into);
  return into;
}

/** Every column a plan reaches, so the file knows whether it still needs the JSON preamble. */
function nestedColumns(node: NestedNode, into: Column[] = []): Column[] {
  into.push(...node.table.columns);
  for (const arm of node.arms) nestedColumns(arm.child, into);
  return into;
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
    if (mode === 'insert' && table.readOnly) continue;
    const plan = buildNestedPlan(table, analysis.tables, analysis.relations ?? [], mode, depth);
    if (plan) out[mode] = plan;
  }
  return out;
}

function renderTableSchemas(
  table: Table,
  affix: ResolvedAffix,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  applyDefaults = false,
  typedColumns?: { schemaSpecifier: string },
  wantsDuplicateFinder = false,
  nested: Partial<Record<NestedMode, NestedNode>> = {},
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
  // Only checks the shared parser understands with certainty; the rest are skipped rather
  // than guessed at, exactly as in the Zod generator, and `parsedChecksFor` also applies the
  // wire policy: see its note.
  const { checks, sets, rows, lengths, cardinalities } = parsedChecksFor(table);
  const tj = typedColumns ? { table: T, mode: 'select' as const } : undefined;
  const tjInsert = typedColumns ? { table: T, mode: 'insert' as const } : undefined;
  // A type-only import: erased at build time, so it adds no runtime dependency on the schema
  // module and cannot create an import cycle.
  //
  // A nested shape references the columns of *other* tables, so those tables have to be named here
  // too or the reference would not resolve. Without this the module compiled fine until
  // `typedColumns` and `nestedSchemas` were combined, and then named an identifier nothing imported.
  const referenced = new Set<string>([T]);
  for (const plan of Object.values(nested)) {
    if (plan) for (const name of nestedTables(plan)) referenced.add(name);
  }
  const schemaImport = typedColumns
    ? `import type { ${[...referenced].join(', ')} } from '${typedColumns.schemaSpecifier}';\n`
    : '';

  const forBrands = brands ? { plan: brands, tsName: T } : undefined;
  const bodyInsert = renderObjectShape(
    insertCols,
    'insert',
    coerceDates,
    checks,
    sets,
    applyDefaults,
    lengths,
    cardinalities,
    tjInsert,
    forBrands
  );
  const bodyUpdate = renderObjectShape(
    updateCols,
    'update',
    coerceDates,
    checks,
    sets,
    applyDefaults,
    lengths,
    cardinalities,
    tjInsert,
    forBrands
  );
  const bodySelect = renderObjectShape(
    selectCols,
    'select',
    coerceDates,
    checks,
    sets,
    applyDefaults,
    lengths,
    cardinalities,
    tj,
    forBrands
  );
  // Emitted only where a json column exists, so a file without one gains nothing unused. The
  // nested shapes carry other tables' columns, so a json column reachable only through a relation
  // still needs the preamble: without this the module named `DrzlJsonValue` and never defined it.
  const nestedCols = Object.values(nested).flatMap((plan) => (plan ? nestedColumns(plan) : []));
  const needsJson = [...insertCols, ...updateCols, ...selectCols, ...nestedCols].some(
    (c) => c.shape?.kind === 'json'
  );

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
    applyDefaults,
    !!typedColumns,
    nested,
    brands
  );

  // The brand read back off the schema that carries it, rather than written out a second time.
  const brandAliases = (brands?.aliasesFor(T) ?? [])
    .map(
      (a) =>
        `/** The nominal type of ${T}.${a.column}. */\n` +
        `export type ${a.alias} = InferOutput<typeof ${selectSchema}>[${JSON.stringify(a.column)}];`
    )
    .join('\n\n');
  const brandCode = brandAliases ? `\n${brandAliases}\n` : '';

  // The canonical helper, once per file that compares on a numeric string wire, nested tables
  // included for the reason the json preamble includes them: their fields render into this same
  // module. Conditional because an unused declaration fails `noUnusedLocals` downstream.
  const nestedNodeTables = (node: NestedNode): Table[] => [
    node.table,
    ...node.arms.flatMap((a) => nestedNodeTables(a.child)),
  ];
  const involved = [
    table,
    ...Object.values(nested).flatMap((plan) => (plan ? nestedNodeTables(plan) : [])),
  ];
  const canonPreamble = involved.some((t) => {
    const own = parsedChecksFor(t);
    return needsNumericCanon(t.columns, own.checks, own.sets);
  })
    ? `\n${NUMERIC_CANON_SOURCE}`
    : '';

  return `import * as v from 'valibot';
import type { InferInput, InferOutput } from 'valibot';
${schemaImport}${needsJson ? `\n${JSON_PREAMBLE}` : ''}${canonPreamble}
export const ${insertSchema} = ${wrapRows(`v.object({\n${bodyInsert}\n})`, rows, insertCols)};

export const ${updateSchema} = ${wrapRows(`v.object({\n${bodyUpdate}\n})`, rows, updateCols)};

export const ${selectSchema} = ${wrapRows(`v.object({\n${bodySelect}\n})`, rows, selectCols)};

export type ${insertType} = InferInput<typeof ${insertSchema}>;
export type ${updateType} = InferInput<typeof ${updateSchema}>;
export type ${selectType} = InferOutput<typeof ${selectSchema}>;
${brandCode}${nestedCode}${duplicates}`;
}

export interface ValibotGenerateOptions extends ValidationGenerateOptions {
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
   * Also emit `constraints.ts`: every CHECK, unique constraint, primary and foreign key on each
   * table, as plain data, plus `constraintForIssue` to map a validation issue back to the
   * constraint that caused it.
   *
   * For a consumer building forms. A schema states what a value must look like and never says
   * which constraint said so, so a failed parse gives a form a message and no way to attribute it;
   * and the two constraints a per-row schema cannot check at all, uniqueness and a foreign key,
   * are absent from the emitted module in every form.
   *
   * The emitted module is library-neutral data, and its matcher reads valibot's path items and
   * zod's alike. Off by default, like every option that adds bytes to the consumer's bundle.
   * `true` is the shorthand for `{ enabled: true }`; `{ errorMap: false }` emits the data without
   * the matcher.
   */
  constraints?: ConstraintsOption;
}

export class ValibotGenerator implements ValidationRenderer<ValibotGenerateOptions> {
  readonly library = 'valibot' as const;
  constructor(private analysis: Analysis) {}

  async generate(opts: ValibotGenerateOptions) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outDir);
    const files: string[] = [];
    await fs.mkdir(out, { recursive: true });
    const affix = resolveAffix(opts);
    const coerceDates = opts.coerceDates ?? 'input';
    const fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;
    // `typedColumns` needs the schema imported back to reference what Drizzle inferred, so it
    // is only possible when the schema path is known. Silently doing nothing would be worse
    // than saying why.
    const typedColumns =
      opts.typedColumns && opts.schemaPath
        ? {
            schemaSpecifier: resolveConfiguredImport(
              opts.schemaPath,
              out,
              process.cwd(),
              opts.importExtension
            ),
          }
        : undefined;
    if (opts.typedColumns && !opts.schemaPath) {
      console.warn(
        '[drzl] typedColumns was requested but the schema path is unknown, so column types stay wide.'
      );
    }
    const nestedDepth = opts.nestedSchemas
      ? resolveNestedDepth(opts.nestedDepth, (m) => console.warn(m))
      : 0;
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
        !!opts.applyDefaults,
        typedColumns,
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
    // Before the barrel, which re-exports it. A file of plain data with no import of its own.
    const constraints = resolveConstraints(opts.constraints);
    if (constraints) {
      const constraintsPath = path.join(out, CONSTRAINTS_MODULE);
      await fs.writeFile(
        constraintsPath,
        await formatCode(
          buildHeader(opts.outputHeader) +
            renderConstraintsModule(this.analysis.tables, constraints),
          constraintsPath,
          opts.format
        ),
        'utf8'
      );
      files.push(constraintsPath);
    }
    const indexPath = path.join(out, 'index.ts');
    const indexCode = this.defaultIndex(this.analysis, opts);
    const indexFormatted = await formatCode(
      buildHeader(opts.outputHeader) + indexCode,
      indexPath,
      opts.format
    );
    await fs.writeFile(indexPath, indexFormatted, 'utf8');
    files.push(indexPath);
    return files;
  }

  renderTable(table: Table, opts?: ValibotGenerateOptions) {
    return renderTableSchemas(
      table,
      resolveAffix(opts),
      opts?.coerceDates ?? 'input',
      !!opts?.applyDefaults,
      undefined,
      !!opts?.duplicateFinder,
      {},
      buildBrandPlan(this.analysis.tables, opts?.branded)
    );
  }

  private defaultIndex(analysis: Analysis, opts: ValibotGenerateOptions) {
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

export default ValibotGenerator;

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
