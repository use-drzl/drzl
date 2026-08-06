import type { Analysis, Table, Column } from '@drzl/analyzer';
import type {
  CardinalityCheck,
  ColumnCheck,
  ColumnSet,
  ResolvedAffix,
  LengthCheck,
  RowCheck,
  ValidationRenderer,
  ValidationGenerateOptions,
} from '@drzl/validation-core';
import {
  COLUMN_FORMATS,
  insertColumns,
  isIntegerColumn,
  parseCheck,
  renderDuplicateFinder,
  updateColumns,
  selectColumns,
  formatCode,
  moduleFileName,
  moduleSpecifier,
  resolveAffix,
  schemaName,
  typeName,
} from '@drzl/validation-core';

type Mode = 'insert' | 'update' | 'select';

/**
 * Suffix appended to the Drizzle export name for every emitted file. The barrel derives
 * its import specifiers from whatever value wins here, so overriding it with `fileSuffix`
 * renames the files and the exports together.
 */
const DEFAULT_FILE_SUFFIX = '.arktype.ts';

function atDateType(
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
): string {
  if (coerceDates === 'none') return 'Date';
  if (coerceDates === 'all') return 'Date | string';
  // 'input'
  return mode === 'select' ? 'Date' : 'Date | string';
}

/**
 * Tighten a numeric range with any CHECK constraints naming this column.
 *
 * ArkType states bounds inside its type expression rather than by chaining, so a check folds
 * into the range instead of becoming a separate assertion: `smallint` with
 * `CHECK (age >= 18)` becomes `18 <= number <= 32767`. That is strictly better than two
 * separate statements, and it is the only form ArkType can express here.
 *
 * `>` and `<` are exclusive, which ArkType spells the same way, so they are kept as given.
 * Equality and inequality are not bounds and are handled separately.
 */
function atNarrowRange(
  c: Column,
  checks: ColumnCheck[]
): { lower?: Bound; upper?: Bound; equals?: string } {
  let lower: Bound | undefined = c.min !== undefined ? { op: '>=', value: c.min } : undefined;
  let upper: Bound | undefined = c.max !== undefined ? { op: '<=', value: c.max } : undefined;
  let equals: string | undefined;

  for (const k of checks.filter((x) => x.column === c.name && x.kind === 'number')) {
    if (k.operator === '>=' || k.operator === '>') lower = { op: k.operator, value: k.value };
    else if (k.operator === '<=' || k.operator === '<') upper = { op: k.operator, value: k.value };
    else if (k.operator === '=') equals = k.value;
  }
  return { lower, upper, equals };
}

/** One end of a range, kept as operator and value because the two ends render differently. */
type Bound = { op: '>=' | '>' | '<=' | '<'; value: string };

/** The flip of each comparison, for moving a bound from the left of the type to its right. */
const MIRROR = { '>=': '<=', '>': '<', '<=': '>=', '<': '>' } as const;

/**
 * A range around a type, in the only forms ArkType parses.
 *
 * A bound may sit on the left only when the other end is on the right: `0 < number` is a parse
 * error, "Left bounds are only valid when paired with right bounds". A lone bound therefore has
 * to be mirrored onto the right, as `number > 0`. Every numeric column but the integers has no
 * declared width, so this is the shape a CHECK on a `numeric` or `double precision` column takes,
 * and it used to emit a module that threw the moment anything imported it.
 */
function atRange(num: string, lower?: Bound, upper?: Bound): string {
  if (lower && upper) return `${lower.value} ${MIRROR[lower.op]} ${num} ${upper.op} ${upper.value}`;
  const only = lower ?? upper;
  return only ? `${num} ${only.op} ${only.value}` : num;
}

/**
 * A column whose value is structured rather than scalar, in ArkType's string DSL.
 *
 * Every form here was checked against ArkType itself, since an expression it cannot parse throws
 * at import and takes the whole module with it. The tuple types are the reason for
 * `number[] == n` rather than a literal `[number, number]`: ArkType does accept a real tuple, but
 * only written as a nested array in the definition object, and this generator emits a string per
 * field. Both reject a wrong-length array; the tuple form would additionally give a static type
 * of `[number, number]` instead of `number[]`.
 */
function atShapeType(c: Column): string | undefined {
  const s = c.shape;
  if (!s) return undefined;
  switch (s.kind) {
    case 'json':
      // Flat rather than recursive, matching what `drizzle-orm/arktype` builds. `object` covers
      // both arrays and records, so nesting needs no separate arm.
      return 'number | object | string | boolean | null';
    case 'custom':
      // See the valibot generator: a custom column carries nothing checkable at runtime.
      return 'unknown';
    case 'buffer':
      return 'TypedArray.Uint8';
    case 'tuple':
      return `number[] == ${s.length}`;
    case 'numberVector':
      return s.length ? `number[] == ${s.length}` : 'number[]';
    case 'bitstring':
      // `== n` for a Postgres `bit(n)`, `<= n` for a Cockroach `varbit(n)`.
      if (!s.length) return '/^[01]*$/';
      return `/^[01]*$/ & string ${s.exact ? '==' : '<='} ${s.length}`;
    case 'byteString':
      // See the zod generator: a MySQL/SingleStore binary column takes any bytes at all and hands
      // them back as a string, so no pattern belongs here. The declared width is a code-point
      // ceiling out and a byte budget in, and `string <= n` is a third measurement that agrees
      // with neither, so the cap goes to `atCapNarrows` where an exact count can be written.
      return 'string';
    case 'numberObject':
      // The one shape with no string form at all: `type({ p: '{ x: number, y: number }' })` throws
      // `'{' is unresolvable`, measured. It is emitted as a Type instance instead, by
      // `atNumberObjectField`, which is why this returns nothing rather than an approximation.
      // Answering `unknown` here would be the same loosening this generator already refuses for a
      // tuple: it accepts a string, an array and null on a NOT NULL column.
      return undefined;
  }
}

function atTypeForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  sets: ColumnSet[] = []
): string {
  const shaped = atShapeType(c);
  if (shaped) return shaped;
  // `CHECK (status IN ('a', 'b'))` is a literal union, which is exactly how ArkType states a set.
  const set = sets.find((x) => x.column === c.name);
  if (set) {
    return set.kind === 'string'
      ? set.values.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(' | ')
      : set.values.join(' | ');
  }
  // A parsed check compares the column to a scalar literal, which describes the array rather
  // than an element. Folded in anyway, `CHECK (tags = 'x')` became `('x')[]`, demanding that
  // every element equal 'x'.
  if (c.arrayDimensions) checks = [];
  if (c.enumValues && c.enumValues.length) {
    return c.enumValues.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(' | ');
  }
  switch (c.tsType) {
    // ArkType constrains inside its string DSL rather than by chaining. Each form below was
    // checked against arktype itself, accepting a valid value and rejecting an invalid one,
    // because an expression it cannot parse throws at import and takes the router with it.
    case 'string': {
      // An equality check pins the value, which ArkType states as a literal type.
      const eq = checks.find(
        (k) => k.column === c.name && k.operator === '=' && k.kind === 'string'
      );
      if (eq) return `'${eq.value.replace(/'/g, "\\'")}'`;
      if (c.format === 'uuid') return 'string.uuid';
      // See the zod generator. ArkType states a pattern as a bare regex literal in its DSL.
      const pattern = c.format ? COLUMN_FORMATS[c.format] : undefined;
      if (pattern) return `/${pattern}/`;
      // Not `string <= n`. That counts UTF-16 code units, and both Postgres and MySQL count a
      // `varchar(n)` in characters, so ten thumbs-up characters are a valid row in a varchar(10)
      // and this refused it. The cap moves to a narrow on the object, where an exact count can be
      // written; a MySQL TEXT byte budget goes the same way.
      return 'string';
    }
    case 'number': {
      const { lower, upper, equals } = atNarrowRange(c, checks);
      if (equals !== undefined) return equals;
      // ArkType does accept both at once: `-2147483648 <= number.integer <= 2147483647` parses
      // and rejects 1.5. Preferring the bound alone, on the theory that a range implied
      // integrality, meant every `integer()` column accepted a fraction.
      return atRange(isIntegerColumn(c) ? 'number.integer' : 'number', lower, upper);
    }
    case 'bigint':
      // Bare here on purpose. The string DSL cannot carry this bound at all:
      // `bigint >= -9223372036854775808n` is a parse error, "Comparator >= must be followed by a
      // corresponding literal", and writing the bound as a number instead rounds it. The range
      // goes on as a narrow, the same builder the character caps use. See `atBigintNarrow`.
      return 'bigint';
    case 'boolean':
      return 'boolean';
    case 'Date':
      return atDateType(mode, coerceDates);
    case 'Uint8Array':
      // `'Uint8Array'` is not an ArkType keyword. It parses as an unresolvable alias and throws
      // at import, so every emitted module holding a binary column was unloadable rather than
      // merely wrong. `TypedArray.Uint8` is the keyword, and it accepts a Node Buffer too.
      return 'TypedArray.Uint8';
    case 'any':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * `CHECK (cardinality(tags) >= 2)` as a bound on the array.
 *
 * ArkType bounds an array's length with the same operators it bounds a number with, so this is
 * one statement about the type rather than an opaque predicate beside it. `<>` has no such form
 * and is left unstated rather than approximated.
 */
function atCardinality(c: Column, cardinalities: CardinalityCheck[]): { lower?: Bound; upper?: Bound; equals?: string } {
  let lower: Bound | undefined;
  let upper: Bound | undefined;
  let equals: string | undefined;
  if (!c.arrayDimensions) return {};
  for (const k of cardinalities.filter((x) => x.column === c.name)) {
    if (k.operator === '>=' || k.operator === '>') lower = { op: k.operator, value: k.value };
    else if (k.operator === '<=' || k.operator === '<') upper = { op: k.operator, value: k.value };
    else if (k.operator === '=') equals = k.value;
  }
  return { lower, upper, equals };
}

/**
 * The whole field line for an object-mode `point` or `line`, as a Type instance.
 *
 * The one column this generator cannot describe in the string DSL: ArkType parses `{` in a
 * definition string as an alias and throws `'{' is unresolvable`, measured, and it throws at
 * import, so an approximation here is a module nothing can load. `type({ x: 'number', y: 'number' })`
 * as the field value does work, and every wrapper the DSL path applies has an instance form that
 * was run rather than assumed:
 *
 *   `.array()` per dimension, `.or("null")` for a nullable column, `?` on the key for an optional
 *   one, `.atLeastLength`/`.moreThanLength`/`.atMostLength`/`.lessThanLength`/`.exactlyLength` for
 *   a cardinality CHECK, and `.default(() => (...))` for an applied default.
 *
 * The default is the one place this is deliberately narrower than the DSL path. ArkType validates
 * a default against the type at build time and throws when it does not fit, so a default that is
 * not an object of the declared number fields would make the emitted module unloadable. Those fall
 * back to an optional key, which is what the column without `applyDefaults` already emits. Not a
 * hole this shape introduced: the DSL path throws outright today for a tuple column carrying an
 * array default, `Expected an expression before '[0,0]'`, which is the same defect one step worse
 * and is reported separately.
 */
function atNumberObjectField(
  c: Column,
  mode: Mode,
  applyDefaults: boolean,
  cardinalities: CardinalityCheck[]
): string | undefined {
  const s = c.shape;
  if (s?.kind !== 'numberObject') return undefined;
  let expr = `type({ ${s.fields.map((f) => `${JSON.stringify(f)}: "number"`).join(', ')} })`;
  for (let i = 0; i < (c.arrayDimensions ?? 0); i++) expr += '.array()';
  const card = atCardinality(c, cardinalities);
  // A whole number or nothing: these methods take a length, and a spliced non-numeric literal
  // would be a syntax error in the emitted module rather than a missing constraint.
  const len = (v: string) => (/^\d+$/.test(v) ? v : undefined);
  const LOWER = { '>=': 'atLeastLength', '>': 'moreThanLength' } as const;
  const UPPER = { '<=': 'atMostLength', '<': 'lessThanLength' } as const;
  if (card.equals !== undefined) {
    const n = len(card.equals);
    if (n) expr += `.exactlyLength(${n})`;
  } else {
    for (const [b, table] of [
      [card.lower, LOWER],
      [card.upper, UPPER],
    ] as const) {
      if (!b) continue;
      const n = len(b.value);
      const method = (table as Record<string, string>)[b.op];
      if (n && method) expr += `.${method}(${n})`;
    }
  }
  if (c.nullable) expr += '.or("null")';
  let optional = false;
  if (mode !== 'select') {
    const d = c.defaultValue;
    const fits =
      mode === 'insert' &&
      applyDefaults &&
      d !== undefined &&
      (c.arrayDimensions
        ? false
        : d === null
          ? c.nullable
          : typeof d === 'object' &&
            s.fields.every((f) => typeof (d as Record<string, unknown>)[f] === 'number'));
    if (fits) expr += d === null ? '.default(null)' : `.default(() => (${JSON.stringify(d)}))`;
    else if (mode === 'update' || c.nullable || c.hasDefault) optional = true;
  }
  return `  ${JSON.stringify(optional ? `${c.name}?` : c.name)}: ${expr},`;
}

/**
 * An applied default, in the two places ArkType can hold one.
 *
 * `dsl` is the literal as the string DSL spells it, and only some values have one: `=` there is
 * followed by a literal, so an object, an array, a Date or a bigint has nothing to write. `expr`
 * is the JavaScript that `.default()` takes on the Type itself, which is where a field rendered
 * as a Type instance has to put its default whatever the value, since `type("string = 'GB'")`
 * throws "Defaultable definitions like 'number = 0' are only valid as properties in an object or
 * tuple" and takes the whole module with it.
 */
type AppliedDefault = { dsl?: string; expr: string };

/**
 * Whether a value survives `JSON.stringify` as itself.
 *
 * Not a formality. `JSON.stringify(Infinity)` is the string `null`, so
 * `doublePrecision().default(Infinity)` emitted `number = null`: ArkType refuses that at import,
 * and had it loaded, the schema would have filled in a different value than the database writes.
 * A Date, a Buffer, a bigint and any class instance are excluded here for the same reason, and
 * get their own arm below or no default at all.
 */
function atJsonValue(v: unknown): boolean {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(atJsonValue);
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(v as Record<string, unknown>).every(atJsonValue);
  }
  return false;
}

/**
 * Whether a value can inhabit the type this file emits for the column, judged on kind alone.
 *
 * ArkType checks a default against its type when the module is built rather than when a row
 * arrives, so a mismatch is a `ParseError` at import: no verdict on any row at all. Kind is what
 * a generator can settle for itself. Whether the value also satisfies the column's *constraints*
 * (an enum's members, a uuid's shape, a range, a character cap) is a question about the schema,
 * and a default the column itself refuses is one the database refuses too.
 */
function atDefaultFits(c: Column, v: unknown, dims: number): boolean {
  // The dimensions belong to the list and everything below them describes an element. A null
  // element does not fit: `c.nullable` wraps the whole array, never its members.
  if (dims > 0) return Array.isArray(v) && v.every((e) => atDefaultFits(c, e, dims - 1));
  switch (c.shape?.kind) {
    case 'json':
    case 'custom':
      return atJsonValue(v);
    case 'buffer':
      // `TypedArray.Uint8`, which nothing reconstructible from JSON satisfies.
      return false;
    case 'tuple':
    case 'numberVector':
      return Array.isArray(v) && v.every((e) => typeof e === 'number' && Number.isFinite(e));
    case 'bitstring':
    case 'byteString':
      return typeof v === 'string';
  }
  switch (c.tsType) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'boolean':
      return typeof v === 'boolean';
    case 'bigint':
      return typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v));
    case 'Date':
      return v instanceof Date || typeof v === 'string' || typeof v === 'number';
    default:
      // Every remaining `tsType` renders as `unknown`, which holds anything reproducible.
      return atJsonValue(v);
  }
}

/**
 * The default to apply to a column, or nothing when none can be reproduced faithfully.
 *
 * Nothing is the honest answer more often than it looks. The analyzer already drops an SQL
 * default and a `$defaultFn`, since the database evaluates the one and Drizzle calls the other,
 * and the key is left merely optional. A literal this generator cannot write down exactly gets
 * the same treatment rather than a value that differs from what the database would have stored.
 */
function atDefault(c: Column, mode: Mode, applyDefaults: boolean): AppliedDefault | undefined {
  if (mode !== 'insert' || !applyDefaults) return undefined;
  const v = c.defaultValue;
  if (v === undefined) return undefined;
  const dims = c.arrayDimensions ?? 0;
  // A null default belongs to the column's nullability rather than to its element type. On a
  // non-nullable column ArkType refuses it at import: "Default must be a string (was null)".
  if (v === null) return c.nullable ? { dsl: 'null', expr: 'null' } : undefined;
  if (!atDefaultFits(c, v, dims)) return undefined;
  // A Date column is rebuilt as a Date whatever Drizzle stored. Its select schema types the
  // column as a Date, and under `coerceDates: 'none'` so does its insert schema, which refuses
  // the ISO string this used to emit: "Default for x must be a Date (was string)".
  if (c.tsType === 'Date' && dims === 0 && !c.shape) {
    const d = v instanceof Date ? v : new Date(v as string | number);
    if (Number.isNaN(d.getTime())) return undefined;
    // A non-primitive default has to arrive as a function: ArkType refuses a value outright,
    // "Non-primitive default must be specified as a function like () => ({my: 'object'})", which
    // is also what keeps one instance from being shared between parses.
    return { expr: `() => new Date(${JSON.stringify(d.toISOString())})` };
  }
  if (typeof v === 'bigint' || (c.tsType === 'bigint' && typeof v === 'number')) {
    // Both forms demand a bigint literal here, and `JSON.stringify` throws on a bigint rather
    // than rendering one, which used to end the whole generate run before a file was written.
    const literal = `${BigInt(v as bigint | number)}n`;
    return { dsl: literal, expr: literal };
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    const literal = JSON.stringify(v);
    return { dsl: literal, expr: literal };
  }
  // An object or an array. No DSL literal exists for either, and the value has to arrive through
  // a function, so both go on the builder.
  return atJsonValue(v) ? { expr: `() => (${JSON.stringify(v)})` } : undefined;
}

function atField(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  sets: ColumnSet[] = [],
  inlineDefault?: AppliedDefault,
  cardinalities: CardinalityCheck[] = [],
  defaulted = false
): string {
  let t = atTypeForColumn(c, mode, coerceDates, checks, sets);
  // The element is parenthesised whenever it is anything but a bare keyword, because `[]` binds
  // tighter than every operator ArkType has: `'a' | 'b'[]` is the literal `'a'` or an array of
  // `'b'`, not an array of either. A plain keyword needs no parentheses and reads better without,
  // so `string[]` stays `string[]` while `('a' | 'b')[]` and `(string <= 255)[]` get them.
  const bare = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(t);
  for (let i = 0; i < (c.arrayDimensions ?? 0); i++) t = bare && i === 0 ? `${t}[]` : `(${t})[]`;
  // Applied after the brackets and before the null union, so the bound binds to the array rather
  // than to the element or to the union.
  const card = atCardinality(c, cardinalities);
  if (card.equals !== undefined) t = `${t} == ${card.equals}`;
  else if (card.lower || card.upper) t = atRange(t, card.lower, card.upper);
  if (c.nullable) t = `(${t} | null)`;
  if (mode !== 'select') {
    // ArkType states a default in the DSL itself: `"string = 'GB'"`. That already makes the key
    // optional, and the two may not be combined: `{ "x?": "string = 'GB'" }` is refused with
    // "Only required keys may specify default values". So an applied default replaces the `?`
    // rather than joining it, wherever the default is finally written. `defaulted` is true even
    // when the value goes on the builder instead, because the key has to stay required either way.
    if (inlineDefault?.dsl !== undefined) t = `${t} = ${inlineDefault.dsl}`;
    else if (!defaulted && (mode === 'update' || c.nullable || c.hasDefault)) t = `${t}?`;
  }
  return t;
}

function renderObjectShape(
  cols: Column[],
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  sets: ColumnSet[] = [],
  applyDefaults = false,
  cardinalities: CardinalityCheck[] = []
) {
  return cols
    .map((c) => {
      // The one shape with no DSL form at all, emitted as a Type instance instead. It builds the
      // whole line, key included, because ArkType marks optionality on the key when the value is a
      // Type rather than with a `?` inside the definition.
      const asType = atNumberObjectField(c, mode, applyDefaults, cardinalities);
      if (asType) return asType;
      const dflt = atDefault(c, mode, applyDefaults);
      // Unconditional, where this used to skip the bigint narrow whenever a default was applied.
      // That skip was documented here as a hole it left open, an insert schema unbounded while
      // select and update were bounded, and said closing it meant moving the default off the DSL
      // and onto the Type. `atDefault` and `onBuilder` below are that move, so the narrow and the
      // default now coexist and the skip is gone.
      const caps = atCapNarrows(c, mode) + atBigintNarrow(c, checks);
      // A defaultable definition is only valid as an object *property*: `type("bigint = 7")`
      // throws "Defaultable definitions like 'number = 0' are only valid as properties in an
      // object or tuple" at import. A field carrying a narrow is exactly that, a `type(...)` call
      // of its own, so its default cannot live in the string and goes to `.default()` on the Type
      // instead, where the narrow survives beside it. A value the DSL has no literal for takes the
      // same route whether or not the field is narrowed.
      const onBuilder = !!dflt && (caps !== '' || dflt.dsl === undefined);
      const dsl = atField(
        c,
        mode,
        coerceDates,
        checks,
        sets,
        onBuilder ? undefined : dflt,
        cardinalities,
        !!dflt
      );
      if (!caps && !onBuilder) return `  ${JSON.stringify(c.name)}: ${JSON.stringify(dsl)},`;

      // A Type instance rather than a DSL string, because neither cap is expressible in the DSL:
      // `string <= n` counts UTF-16 code units, which agrees with neither database. ArkType marks
      // optionality on the key when the value is a Type, so the `?` moves there.
      const optional = dsl.endsWith('?');
      const inner = optional ? dsl.slice(0, -1) : dsl;
      const key = JSON.stringify(optional ? `${c.name}?` : c.name);
      // The whole rendered type, unpicked no further. This used to strip the array brackets off
      // to narrow the element and then call `.array()` to put them back, which was correct only
      // for a bare `T[]`: a nullable array renders `(T[] | null)` and the union became the
      // element, and a two-dimensional array came out three deep. The dimensions belong to the
      // DSL, which already gets them right, and `atNarrow` walks into them instead.
      //
      // The default goes last, after the narrows, so ArkType checks it against the constraint it
      // is defaulting into: a value the column itself refuses is refused here too.
      const applied = onBuilder ? `.default(${dflt!.expr})` : '';
      return `  ${key}: type(${JSON.stringify(inner)})${caps}${applied},`;
    })
    .join('\n');
}

/**
 * `.narrow(...)` calls that belong on the object rather than on a field.
 *
 * `CHECK (start_date < end_date)` is a statement about the row. ArkType states one through
 * `.narrow`, which is its builder rather than its string DSL, so unlike every other constraint
 * this generator emits it appends to the `type({...})` call rather than living inside a field
 * string.
 *
 * Both sides are guarded for null first, reproducing SQL, where a comparison involving NULL
 * yields NULL and the CHECK passes.
 */
function atRowNarrows(rows: RowCheck[], cols: Column[]): string {
  const present = new Set(cols.map((c) => c.name));
  const OPS: Record<RowCheck['operator'], string> = {
    '>=': '>=',
    '>': '>',
    '<=': '<=',
    '<': '<',
    '=': '===',
    '<>': '!==',
  };
  return rows
    // A check naming a column this mode does not carry cannot be evaluated.
    .filter((r) => present.has(r.left) && present.has(r.right))
    .map((r) => {
      const l = `o[${JSON.stringify(r.left)}]`;
      const rt = `o[${JSON.stringify(r.right)}]`;
      const msg = JSON.stringify(`${r.name ? `${r.name}: ` : ''}${r.left} ${r.operator} ${r.right}`);
      return `.narrow((o, ctx) => ${l} == null || ${rt} == null || ${l} ${OPS[r.operator]} ${rt} || ctx.mustBe(${msg}))`;
    })
    .join('');
}

/**
 * `CHECK (length(name) >= 3)` as a narrow on the object.
 *
 * It cannot be `string >= 3`. ArkType's string bound counts UTF-16 code units and SQL's
 * `length()` counts characters, so three thumbs-up characters are six units to ArkType. For a
 * minimum that only under-enforces; for a maximum it refuses rows the database accepts. The
 * spread operator counts characters, and a narrow is where an expression can be written at all,
 * so both ends go here rather than one being right and the other quietly wrong.
 *
 * Null and absent both pass, matching SQL, where a check involving NULL is satisfied.
 */
/**
 * One field-level narrow, whose predicate reaches the element of an array column.
 *
 * Every constraint this file puts on a field describes a *value*: how many characters it has, what
 * range it lies in. For an array column that is a statement about each element, while the column's
 * own nullability is a statement about the list. The two used to be separated by string surgery:
 * the rendered type had a trailing `[]` stripped off to recover the element, the narrow went on
 * that, and `.array()` put the list back.
 *
 * It only ever worked when nothing else was wrapped around the brackets. A nullable array renders
 * as `(bigint[] | null)`, so the whole union became the "element" and `.array()` wrapped it: the
 * schema then refused `null` and `[1n]`, accepted `[[1n]]` and `[null]`, and for a bigint would
 * not even compile, since `>=` cannot be applied to `bigint[]`. A two-dimensional array came out a
 * dimension too deep for the same reason.
 *
 * So the narrow stays on the whole value, where the DSL string is already correct about
 * dimensions, nullability and any cardinality bound, and the predicate walks in one `.every` per
 * dimension instead. `.every` on an empty list is true, which is right: a list with no elements
 * breaks no constraint on elements. Null passes at every level, matching SQL, where a comparison
 * involving NULL leaves the check satisfied.
 *
 * A narrow is not reached at all unless the base type already matched, so the `.every` is only
 * ever called on something ArkType has confirmed is an array.
 */
function atNarrow(c: Column, predicate: (v: string) => string, message: string): string {
  const dims = c.arrayDimensions ?? 0;
  // `v` for the value itself, so a non-array column emits exactly what it always did.
  const name = (i: number) => (i === 0 ? 'v' : `e${i}`);
  let body = predicate(name(dims));
  for (let i = dims; i > 0; i--) {
    body = `${name(i - 1)}.every((${name(i)}) => ${name(i)} == null || ${body})`;
  }
  return `.narrow((v, ctx) => v == null || ${body} || ctx.mustBe(${JSON.stringify(message)}))`;
}

/**
 * A bigint column's range as a narrow, because the string DSL cannot state one.
 *
 * `type('bigint >= -9223372036854775808n')` throws "Comparator >= must be followed by a
 * corresponding literal", and the same bound written as a number rounds: 9223372036854775807
 * is not representable as a double. So this generator emitted a bare `bigint` and accepted
 * `2n ** 70n`, which every other generator rejects and which no int64 column can hold, so the
 * schema promised a write the database refuses. The packed gate had it waived on all three
 * dialects. Being looser than the first-party validator is not what made it wrong, though an
 * earlier version of this sentence said it was the one direction generated output must never
 * take: that gate counts its looser entries and most of them run that way.
 *
 * A narrow can hold it, exactly as the character caps do. Null passes, matching SQL and matching
 * the cap narrows, so the guard belongs here rather than in a wrapping union.
 */
function atBigintNarrow(c: Column, checks: ColumnCheck[]): string {
  if (c.tsType !== 'bigint' || c.shape) return '';
  const { lower, upper, equals } = atNarrowRange(c, checks);
  // A bigint literal has to be an integer: `1.5n` is a syntax error, and an emitted module that
  // does not parse throws at import and takes everything importing it with it. A bound this
  // cannot render is left off rather than rendered wrongly.
  const literal = (v: string) => (/^-?\d+$/.test(v) ? `${v}n` : undefined);
  const parts: ((v: string) => string)[] = [];
  if (equals !== undefined) {
    const e = literal(equals);
    if (!e) return '';
    parts.push((v) => `${v} === ${e}`);
  } else {
    for (const b of [lower, upper]) {
      if (!b) continue;
      const l = literal(b.value);
      if (!l) return '';
      parts.push((v) => `${v} ${b.op} ${l}`);
    }
  }
  if (!parts.length) return '';
  return atNarrow(
    c,
    (v) => `(${parts.map((p) => p(v)).join(' && ')})`,
    equals !== undefined
      ? `exactly ${equals}`
      : `between ${lower?.value ?? 'any'} and ${upper?.value ?? 'any'}`
  );
}

/**
 * Column caps as narrows: characters for `varchar(n)`, bytes for MySQL's TEXT family.
 *
 * Neither is expressible in the string DSL. `string <= n` counts UTF-16 code units, which is a
 * third measurement, agreeing with neither. Both databases count `varchar(n)` in characters and
 * MySQL counts `tinytext` in bytes, so both are written out here rather than approximated.
 */
function atCapNarrows(c: Column, mode: Mode): string {
  // A byte-string column is the one shaped column that carries a cap. It reaches this function
  // rather than stating the cap in its own DSL because neither of its two measurements is
  // expressible there, and because which one applies depends on the mode: n code points is what
  // the column can return, n bytes is what the server accepts. Both were measured against MySQL
  // 8.4; see the analyzer's `ColumnShape`.
  if (c.shape?.kind === 'byteString') {
    const n = c.shape.length;
    if (!n) return '';
    return mode === 'select'
      ? atNarrow(c, (v) => `[...${v}].length <= ${n}`, `at most ${n} characters`)
      : atNarrow(c, (v) => `new TextEncoder().encode(${v}).length <= ${n}`, `at most ${n} bytes`);
  }
  if (c.tsType !== 'string' || c.shape) return '';
  const out: string[] = [];
  if (c.maxLength) {
    out.push(atNarrow(c, (v) => `[...${v}].length <= ${c.maxLength}`, `at most ${c.maxLength} characters`));
  }
  if (c.maxBytes) {
    out.push(
      atNarrow(
        c,
        (v) => `new TextEncoder().encode(${v}).length <= ${c.maxBytes}`,
        `at most ${c.maxBytes} bytes`
      )
    );
  }
  return out.join('');
}

function atLengthNarrows(lengths: LengthCheck[], cols: Column[]): string {
  const present = new Set(cols.map((c) => c.name));
  const OPS: Record<LengthCheck['operator'], string> = {
    '>=': '>=',
    '>': '>',
    '<=': '<=',
    '<': '<',
    '=': '===',
    '<>': '!==',
  };
  return lengths
    .filter((k) => present.has(k.column))
    .map((k) => {
      const v = `o[${JSON.stringify(k.column)}]`;
      const msg = JSON.stringify(
        `${k.name ? `${k.name}: ` : ''}length(${k.column}) ${k.operator} ${k.value}`
      );
      return `.narrow((o, ctx) => ${v} == null || [...${v}].length ${OPS[k.operator]} ${k.value} || ctx.mustBe(${msg}))`;
    })
    .join('');
}

function renderTableSchemas(
  table: Table,
  affix: ResolvedAffix,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  applyDefaults = false,
  wantsDuplicateFinder = false
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
  const parsedChecks = (table.checks ?? []).map((k) => parseCheck(k.expression, k.name));
  const checks = parsedChecks.flatMap((p) => (p.ok ? p.checks : []));
  const sets = parsedChecks.flatMap((p) => (p.ok ? (p.sets ?? []) : []));
  const rows = parsedChecks.flatMap((p) => (p.ok ? (p.rows ?? []) : []));
  const cardinalities = parsedChecks.flatMap((p) => (p.ok ? (p.cardinalities ?? []) : []));
  const lengths = parsedChecks.flatMap((p) => (p.ok ? (p.lengths ?? []) : []));
  const bodyInsert = renderObjectShape(
    insertCols,
    'insert',
    coerceDates,
    checks,
    sets,
    applyDefaults,
    cardinalities
  );
  const bodyUpdate = renderObjectShape(
    updateCols,
    'update',
    coerceDates,
    checks,
    sets,
    applyDefaults,
    cardinalities
  );
  const bodySelect = renderObjectShape(
    selectCols,
    'select',
    coerceDates,
    checks,
    sets,
    applyDefaults,
    cardinalities
  );
    // Uniqueness is a fact about the table, so no per-row schema can see it. This checks the
  // half that needs no database: whether a batch collides with itself.
  const finder = wantsDuplicateFinder
    ? renderDuplicateFinder(table, `findDuplicate${T}`, insertType)
    : undefined;
  const duplicates = finder ? `\n${finder}\n` : '';

return `import { type } from 'arktype';

export const ${insertSchema} = type({
${bodyInsert}
})${atRowNarrows(rows, insertCols)}${atLengthNarrows(lengths, insertCols)};

export const ${updateSchema} = type({
${bodyUpdate}
})${atRowNarrows(rows, updateCols)}${atLengthNarrows(lengths, updateCols)};

export const ${selectSchema} = type({
${bodySelect}
})${atRowNarrows(rows, selectCols)}${atLengthNarrows(lengths, selectCols)};

export type ${insertType} = typeof ${insertSchema}["infer"];
export type ${updateType} = typeof ${updateSchema}["infer"];
export type ${selectType} = typeof ${selectSchema}["infer"];
${duplicates}`;
}

export interface ArkTypeGenerateOptions extends ValidationGenerateOptions {
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

export class ArkTypeGenerator implements ValidationRenderer<ArkTypeGenerateOptions> {
  readonly library = 'arktype' as const;
  constructor(private analysis: Analysis) {}

  async generate(opts: ArkTypeGenerateOptions) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outDir);
    const files: string[] = [];
    await fs.mkdir(out, { recursive: true });
    const affix = resolveAffix(opts);
    const coerceDates = opts.coerceDates ?? 'input';
    const fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;
    // File names deliberately stay on the raw Drizzle export name: affixes and tableCase
    // rename identifiers, never modules, so the barrel and importPath keep resolving.
    for (const table of this.analysis.tables) {
      const filePath = path.join(out, moduleFileName(table.tsName, fileSuffix));
      const code = renderTableSchemas(table, affix, coerceDates, !!opts.applyDefaults,
      !!opts?.duplicateFinder);
      const formatted = await formatCode(
        buildHeader(opts.outputHeader) + code,
        filePath,
        opts.format
      );
      await fs.writeFile(filePath, formatted, 'utf8');
      files.push(filePath);
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

  renderTable(table: Table, opts?: ArkTypeGenerateOptions) {
    return renderTableSchemas(
      table,
      resolveAffix(opts),
      opts?.coerceDates ?? 'input',
      !!opts?.applyDefaults,
      !!opts?.duplicateFinder
    );
  }

  private defaultIndex(analysis: Analysis, opts: ArkTypeGenerateOptions) {
    const fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;
    const exports = analysis.tables
      .map((t) => `export * from '${moduleSpecifier(t.tsName, fileSuffix, opts.importExtension)}';`)
      .join('\n');
    return exports + '\n';
  }
}

export default ArkTypeGenerator;

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
