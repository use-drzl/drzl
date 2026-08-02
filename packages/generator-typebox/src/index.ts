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
import {
  formatCode,
  COLUMN_FORMATS,
  insertColumns,
  isIntegerColumn,
  moduleFileName,
  moduleSpecifier,
  parseCheck,
  renderDuplicateFinder,
  resolveAffix,
  resolveConfiguredImport,
  schemaName,
  selectColumns,
  typeName,
  updateColumns,
} from '@drzl/validation-core';

type Mode = 'insert' | 'update' | 'select';

/**
 * Suffix appended to the Drizzle export name for every emitted file. The barrel derives its
 * import specifiers from whatever value wins here, so overriding it with `fileSuffix` renames
 * the files and the exports together.
 */
const DEFAULT_FILE_SUFFIX = '.typebox.ts';

/**
 * A uuid as a pattern, not `format: 'uuid'`.
 *
 * TypeBox does not check formats unless the consuming project has registered them on
 * `FormatRegistry` first. Verified against 0.34: in a project that has not,
 * `Value.Check(Type.String({ format: 'uuid' }), '<a real uuid>')` returns **false**, so emitting
 * a format would reject every valid uuid in exactly the projects least likely to work out why.
 * A pattern needs no setup and behaves the same everywhere.
 */
const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/** Render a TypeBox options object, or nothing when there is nothing to pass. */
function renderOptions(entries: Array<[string, string]>): string {
  if (!entries.length) return '';
  return `{ ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')} }`;
}

function tbDateType(
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
): string {
  // TypeBox has no Date primitive that also accepts an ISO string, so a coercing position is
  // stated as the union the value can actually be.
  if (coerceDates === 'none') return 'Type.Date()';
  const union = 'Type.Union([Type.Date(), Type.String()])';
  if (coerceDates === 'all') return union;
  return mode === 'select' ? 'Type.Date()' : union;
}

/**
 * `minimum` and `maximum` for a column declaring an integer range.
 *
 * Bounds arrive as decimal strings, because a 64 bit bound cannot survive a JS number, and are
 * pasted through rather than parsed.
 */
function tbBounds(c: Column): Array<[string, string]> {
  if (c.min === undefined || c.max === undefined) return [];
  return [
    ['minimum', c.min],
    ['maximum', c.max],
  ];
}

/**
 * CHECK constraints naming this column, as TypeBox options.
 *
 * TypeBox states comparisons declaratively, so a check becomes `minimum`, `maximum`,
 * `exclusiveMinimum`, `exclusiveMaximum` or `const` rather than an opaque predicate. An
 * inequality has no counterpart that leaves the rest of the type intact, so it is left unstated
 * rather than approximated.
 */
function tbEqualityLiteral(c: Column, checks: ColumnCheck[]): string | undefined {
  const eq = checks.find((k) => k.column === c.name && k.operator === '=');
  if (!eq) return undefined;
  // `Type.Literal` is the only form TypeBox enforces. A `const` option on `Type.String` or
  // `Type.Integer` parses fine and then accepts anything, which is worse than not emitting it.
  return `Type.Literal(${eq.kind === 'string' ? JSON.stringify(eq.value) : eq.value})`;
}

function tbCheckOptions(c: Column, checks: ColumnCheck[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const k of checks.filter((x) => x.column === c.name)) {
    if (k.kind === 'number') {
      if (k.operator === '>=') out.push(['minimum', k.value]);
      else if (k.operator === '>') out.push(['exclusiveMinimum', k.value]);
      else if (k.operator === '<=') out.push(['maximum', k.value]);
      else if (k.operator === '<') out.push(['exclusiveMaximum', k.value]);
      // Equality is handled as a literal type, not here: verified against TypeBox 0.34 that
      // `Type.Integer({ const: 5 })` accepts 6, so a `const` option is silently ignored.
    }
  }
  return out;
}

/** Name of the recursive JSON schema emitted into a file that has any json column. */
const JSON_CONST = 'DrzlJsonValue';

/**
 * A recursive definition of the JSON value space, emitted once per file.
 *
 * `Type.Unknown()` accepted `undefined`, `NaN`, `Infinity`, bigints, Dates and Buffers, none of
 * which survive a round trip through a json column. `Type.Recursive` is what lets the nested
 * cases refer back to the whole, so a `{ a: { b: [1, 'x'] } }` is checked all the way down.
 */
const JSON_PREAMBLE = `const ${JSON_CONST} = Type.Recursive((This) =>
  Type.Union([
    Type.String(),
    Type.Number(),
    Type.Boolean(),
    Type.Null(),
    Type.Array(This),
    Type.Record(Type.String(), This),
  ])
);
`;

/**
 * A column whose value is structured rather than scalar.
 *
 * These used to land on `Type.Unknown()`, or for the tuple types on `Type.String()`, which
 * rejected every row: a `point` really arrives as `[number, number]`.
 */
function tbShapeExpr(c: Column, typedJsonRef?: string): string | undefined {
  const s = c.shape;
  if (!s) return undefined;
  switch (s.kind) {
    case 'json':
      // `typedJson` still wins, since the inferred type is narrower than "any JSON".
      if (typedJsonRef) return `Type.Unsafe<${typedJsonRef}>(Type.Unknown())`;
      return JSON_CONST;
    case 'custom':
      // Nothing to check at runtime: see the zod generator for why guessing from `getSQLType()`
      // would be wrong. `Type.Unsafe<T>` is TypeBox's escape hatch for exactly this.
      return typedJsonRef ? `Type.Unsafe<${typedJsonRef}>(Type.Unknown())` : 'Type.Unknown()';
    case 'buffer':
      return 'Type.Uint8Array()';
    case 'tuple':
      return `Type.Tuple([${Array.from({ length: s.length }, () => 'Type.Number()').join(', ')}])`;
    case 'numberVector':
      return `Type.Array(Type.Number()${s.length ? `, { minItems: ${s.length}, maxItems: ${s.length} }` : ''})`;
    case 'bitstring':
      // `pattern` rather than `format`, which TypeBox ignores unless the consuming project has
      // registered it on `FormatRegistry` first.
      // Both bounds for a Postgres `bit(n)`, only the ceiling for a MySQL `binary(n)`.
      if (!s.length) return `Type.String({ pattern: '^[01]*$' })`;
      return s.exact
        ? `Type.String({ pattern: '^[01]*$', minLength: ${s.length}, maxLength: ${s.length} })`
        : `Type.String({ pattern: '^[01]*$', maxLength: ${s.length} })`;
  }
}

/**
 * `CHECK (cardinality(tags) >= 2)` as `minItems` and `maxItems`.
 *
 * These are the JSON Schema keywords for an array length, so the constraint survives
 * serialisation rather than living in a predicate that cannot. JSON Schema has no exclusive form
 * of either, but a length is an integer, so `> 2` is exactly `minItems: 3` and nothing is
 * approximated by the rewrite. `<>` has no keyword at all and is left unstated.
 */
function tbCardinalityOptions(c: Column, cardinalities: CardinalityCheck[]): Array<[string, string]> {
  if (!c.arrayDimensions) return [];
  const out = new Map<string, string>();
  const step = (v: string, by: number) => String(BigInt(v) + BigInt(by));
  for (const k of cardinalities.filter((x) => x.column === c.name)) {
    if (k.operator === '>=') out.set('minItems', k.value);
    else if (k.operator === '>') out.set('minItems', step(k.value, 1));
    else if (k.operator === '<=') out.set('maxItems', k.value);
    else if (k.operator === '<') out.set('maxItems', step(k.value, -1));
    else if (k.operator === '=') {
      out.set('minItems', k.value);
      out.set('maxItems', k.value);
    }
  }
  return [...out];
}

function tbExprForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  typedJsonRef?: string,
  sets: ColumnSet[] = []
): string {
  const shaped = tbShapeExpr(c, typedJsonRef);
  if (shaped) return shaped;
  // `CHECK (status IN ('a', 'b'))` is a union of literals. `Type.Literal` is the only form
  // TypeBox enforces: a `const` option parses and then accepts anything.
  const set = sets.find((x) => x.column === c.name);
  if (set) {
    const lits = set.values.map((v) =>
      set.kind === 'string' ? `Type.Literal(${JSON.stringify(v)})` : `Type.Literal(${v})`
    );
    return `Type.Union([${lits.join(', ')}])`;
  }
  // A parsed check compares the column against a scalar literal, which describes an element
  // rather than the array. Applied anyway, `CHECK (tags = 'x')` collapsed the whole column to
  // `Type.Literal("x")`.
  if (c.arrayDimensions) checks = [];
  if (c.enumValues && c.enumValues.length) {
    const vals = c.enumValues.map((v) => `Type.Literal(${JSON.stringify(v)})`).join(', ');
    return `Type.Union([${vals}])`;
  }

  // A check can tighten a bound the column type already set, so its options are applied last
  // and win on conflict.
  // An equality pins the value outright, so it supersedes every other constraint.
  const literal = tbEqualityLiteral(c, checks);
  if (literal) return literal;

  const checkOpts = tbCheckOptions(c, checks);
  const merged = (base: Array<[string, string]>) => {
    const seen = new Map(base);
    for (const [k, v] of checkOpts) seen.set(k, v);
    return [...seen.entries()];
  };

  switch (c.tsType) {
    case 'string': {
      // A pattern for any format the database enforces, `uuid` included. See the zod generator:
      // a bare string accepted values Postgres rejects, and `format` is not an option here
      // because TypeBox ignores it unless the consuming project registered it first.
      const formatPattern = c.format === 'uuid' ? UUID_PATTERN : COLUMN_FORMATS[c.format ?? ''];
      // Not `maxLength`. That keyword counts UTF-16 code units, and both Postgres and MySQL count
      // a `varchar(n)` in characters, so ten thumbs-up characters are a valid row in a varchar(10)
      // and this refused it. The cap moves to the registered kind, where an exact count can be
      // written; a MySQL TEXT byte budget goes the same way.
      const base: Array<[string, string]> = formatPattern
        ? [['pattern', JSON.stringify(formatPattern)]]
        : [];
      return tbCapExpr(c, `Type.String(${renderOptions(merged(base))})`);
    }
    case 'number': {
      const o = renderOptions(merged(tbBounds(c)));
      return isIntegerColumn(c) ? `Type.Integer(${o})` : `Type.Number(${o})`;
    }
    case 'bigint':
      // `minimum`/`maximum` do take bigint values here, verified by running the emitted schema:
      // `Type.BigInt({ maximum: 100n })` rejects `1000n`. Writing the bound as a plain number
      // would be the broken form, since 9223372036854775807 rounds up the moment it becomes one,
      // so the literals are emitted with the `n` suffix and the bound stays exact.
      return c.min !== undefined && c.max !== undefined
        ? `Type.BigInt({ minimum: ${c.min}n, maximum: ${c.max}n })`
        : 'Type.BigInt()';
    case 'boolean':
      return 'Type.Boolean()';
    case 'Date':
      return tbDateType(mode, coerceDates);
    case 'Uint8Array':
      return 'Type.Uint8Array()';
    case 'any':
      // `typedJson` swaps the wide type for the one Drizzle inferred. `Type.Unsafe<T>` is
      // TypeBox's own escape hatch for a static type it cannot narrow at runtime.
      if (typedJsonRef) return `Type.Unsafe<${typedJsonRef}>(Type.Unknown())`;
      return 'Type.Unknown()';
    default:
      return 'Type.Unknown()';
  }
}

/**
 * Attach a JSON Schema `default` to whatever schema expression this is.
 *
 * `Type.String()` renders with no options and `Type.String({ maxLength: 5 })` renders with some,
 * so the annotation is added by re-opening the call rather than by string surgery on the options
 * object, which would have to parse what is already there.
 */
function withDefault(expr: string, value: unknown): string {
  const json = JSON.stringify(value);
  const open = expr.lastIndexOf('(');
  const close = expr.lastIndexOf(')');
  // Only a bare `Type.X()` or `Type.X({...})` can take one. Anything composed, a union or a
  // pipe, has no single place to put it, and guessing would attach it to the wrong member.
  if (!/^Type\.[A-Za-z]+\(/.test(expr) || open === -1 || close !== expr.length - 1) return expr;
  const inner = expr.slice(open + 1, close).trim();
  if (!inner) return `${expr.slice(0, open)}({ default: ${json} })`;
  if (inner.startsWith('{') && inner.endsWith('}')) {
    return `${expr.slice(0, open)}({ ${inner.slice(1, -1).trim().replace(/,$/, '')}, default: ${json} })`;
  }
  return `${expr.slice(0, close)}, { default: ${json} })`;
}

function tbField(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  typedJsonRef?: string,
  sets: ColumnSet[] = [],
  applyDefault = false,
  narrowRef?: string,
  cardinalities: CardinalityCheck[] = []
): string {
  let expr = tbExprForColumn(c, mode, coerceDates, checks, typedJsonRef, sets);
  // Drizzle keeps an array on the element's own column class, so everything above describes the
  // element and the wrapping belongs out here, after its bounds are attached.
  // The length bound belongs on the outermost array, which is the one `cardinality()` counts.
  const cardOpts = renderOptions(tbCardinalityOptions(c, cardinalities));
  const dims = c.arrayDimensions ?? 0;
  for (let i = 0; i < dims; i++) {
    expr = `Type.Array(${expr}${i === dims - 1 && cardOpts ? `, ${cardOpts}` : ''})`;
  }
  // Nullability wraps the constrained type, so null skips the constraint. That reproduces SQL,
  // where a CHECK passes when it evaluates to TRUE or NULL.
  if (c.nullable) expr = `Type.Union([${expr}, Type.Null()])`;
  // The default goes on the schema itself, before anything wraps it. Applied after the
  // `Type.Unsafe` wrapper instead, it landed on the wrapper, where `withDefault` declines to
  // touch it and the default was silently dropped: the field carried none at all and nothing
  // said so.
  //
  // `Value.Check` does not materialise a default, only `Value.Parse` and `Value.Default` do:
  // TypeBox separates validating from defaulting where zod and valibot fold the two together.
  const wantsDefault = mode === 'insert' && applyDefault && c.defaultValue !== undefined;
  if (wantsDefault) expr = withDefault(expr, c.defaultValue);

  // `typedColumns` narrows the static type without touching the runtime schema. `Type.Unsafe<T>`
  // is TypeBox's own primitive for exactly that: it wraps an existing schema, so every check it
  // carries still runs, and only the inferred type is replaced.
  if (narrowRef) expr = `Type.Unsafe<${narrowRef}>(${expr})`;

  if (mode !== 'select') {
    if (wantsDefault || mode === 'update' || c.nullable || c.hasDefault) {
      expr = `Type.Optional(${expr})`;
    }
  }
  return expr;
}

function renderObjectShape(
  cols: Column[],
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  typedJson?: { table: string; mode: 'insert' | 'select'; allColumns?: boolean },
  sets: ColumnSet[] = [],
  applyDefaults = false,
  cardinalities: CardinalityCheck[] = []
) {
  return cols
    .map((c) => {
      const refFor = (t: { table: string; mode: 'insert' | 'select' }) =>
        `(typeof ${t.table}.$infer${t.mode === 'insert' ? 'Insert' : 'Select'})[${JSON.stringify(c.name)}]`;
      const replaces = c.tsType === 'any' || c.shape?.kind === 'custom';
      const narrow = typedJson?.allColumns && !replaces ? refFor(typedJson) : undefined;
      const ref =
        typedJson && (c.tsType === 'any' || c.shape?.kind === 'custom')
          ? `(typeof ${typedJson.table}.$infer${typedJson.mode === 'insert' ? 'Insert' : 'Select'})[${JSON.stringify(c.name)}]`
          : undefined;
      return `  ${JSON.stringify(c.name)}: ${tbField(c, mode, coerceDates, checks, ref, sets, applyDefaults, narrow, cardinalities)},`;
    })
    .join('\n');
}

function renderTableSchemas(
  table: Table,
  affix: ResolvedAffix,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  typedJson?: { schemaSpecifier: string; allColumns?: boolean },
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

  // Only checks the shared parser understands with certainty. Ambiguous ones are skipped rather
  // than guessed at, identically to the other validation generators.
  const parsedChecks = (table.checks ?? []).map((k) => parseCheck(k.expression, k.name));
  const checks = parsedChecks.flatMap((p) => (p.ok ? p.checks : []));
  const sets = parsedChecks.flatMap((p) => (p.ok ? (p.sets ?? []) : []));
  const rows = parsedChecks.flatMap((p) => (p.ok ? (p.rows ?? []) : []));
  const cardinalities = parsedChecks.flatMap((p) => (p.ok ? (p.cardinalities ?? []) : []));
  const lengths = parsedChecks.flatMap((p) => (p.ok ? (p.lengths ?? []) : []));

  const tj = typedJson
    ? { table: T, mode: 'select' as const, allColumns: typedJson.allColumns }
    : undefined;
  const tjInsert = typedJson
    ? { table: T, mode: 'insert' as const, allColumns: typedJson.allColumns }
    : undefined;
  const bodyInsert = renderObjectShape(
    insertCols,
    'insert',
    coerceDates,
    checks,
    tjInsert,
    sets,
    applyDefaults,
    cardinalities
  );
  const bodyUpdate = renderObjectShape(
    updateCols,
    'update',
    coerceDates,
    checks,
    tjInsert,
    sets,
    applyDefaults,
    cardinalities
  );
  const bodySelect = renderObjectShape(
    selectCols,
    'select',
    coerceDates,
    checks,
    tj,
    sets,
    applyDefaults,
    cardinalities
  );

  const schemaImport = typedJson
    ? `import type { ${T} } from '${typedJson.schemaSpecifier}';\n`
    : '';

  // Emitted only where a json column exists, and not when `typedJson` has replaced it with the
  // inferred type, so a file never carries an unused declaration.
  const needsJson =
    !typedJson &&
    [...insertCols, ...updateCols, ...selectCols].some((c) => c.shape?.kind === 'json');

  const rowCols = [insertCols, updateCols, selectCols].map(
    (cols) => new Set(cols.map((c) => c.name))
  );
  const needsRows =
    rows.some((r) => rowCols.some((s) => s.has(r.left) && s.has(r.right))) ||
    lengths.some((k) => rowCols.some((s) => s.has(k.column))) ||
    [insertCols, updateCols, selectCols].some((cs) => cs.some(tbNeedsCapKind));
  const rowImport = needsRows ? `, Kind, TypeRegistry` : '';

    // Uniqueness is a fact about the table, so no per-row schema can see it. This checks the
  // half that needs no database: whether a batch collides with itself.
  const finder = wantsDuplicateFinder
    ? renderDuplicateFinder(table, `findDuplicate${T}`, insertType)
    : undefined;
  const duplicates = finder ? `\n${finder}\n` : '';

return `import { Type${rowImport} } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
${schemaImport}${needsJson ? `\n${JSON_PREAMBLE}` : ''}${needsRows ? `\n${ROW_PREAMBLE}` : ''}
export const ${insertSchema} = ${tbWrapRows(`Type.Object({\n${bodyInsert}\n})`, rows, insertCols, lengths)};

export const ${updateSchema} = ${tbWrapRows(`Type.Object({\n${bodyUpdate}\n})`, rows, updateCols, lengths)};

export const ${selectSchema} = ${tbWrapRows(`Type.Object({\n${bodySelect}\n})`, rows, selectCols, lengths)};

export type ${insertType} = Static<typeof ${insertSchema}>;
export type ${updateType} = Static<typeof ${updateSchema}>;
export type ${selectType} = Static<typeof ${selectSchema}>;
${duplicates}`;
}

/**
 * The registry entry a row-level check needs, emitted once per file that has one.
 *
 * TypeBox has no `.refine`. What it has is a type registry: a kind whose check function is looked
 * up at validation time, honoured by both `Value.Check` and `TypeCompiler`. Registering is
 * idempotent, so several generated modules in one process are fine.
 */
const ROW_PREAMBLE = `TypeRegistry.Set('DrzlRowCheck', (schema: any, value: any) =>
  schema.assert(value)
);
`;

/**
 * A row-level CHECK as a branch of an intersection.
 *
 * Intersecting rather than setting the kind on the object itself is what keeps the properties
 * checked. `{ ...Type.Object({...}), [Kind]: 'DrzlRowCheck' }` parses, validates the predicate,
 * and quietly stops validating the fields, so `{ lo: 'x' }` passes.
 *
 * The branch carries no JSON Schema keywords, so `JSON.stringify` renders it as `{}` and the
 * document stays valid: JSON Schema cannot compare two fields, and an empty branch says nothing
 * rather than something wrong. `description` survives for a reader, and a failing validation
 * reports it on `error.schema.description`.
 */
/**
 * `CHECK (length(name) >= 3)` as branches of the same intersection the row checks use.
 *
 * Not `minLength`. That keyword counts UTF-16 code units and SQL's `length()` counts characters,
 * so three thumbs-up characters are six units: for a minimum that under-enforces, and for a
 * maximum it refuses rows the database accepts. The spread operator counts characters, and the
 * registered kind is the only place an expression can live, so both ends go here.
 *
 * The cost is that this constraint does not survive serialisation to JSON Schema, where a bare
 * `minLength` would. Emitting the wrong count in a form that serialises is not a better trade.
 */
/**
 * Column caps as intersection branches: characters for `varchar(n)`, bytes for MySQL's TEXT
 * family.
 *
 * `maxLength` and `minLength` count UTF-16 code units, which agrees with neither database. Both
 * count `varchar(n)` in characters and MySQL counts `tinytext` in bytes, so both are written out
 * as predicates rather than approximated by a keyword that means a third thing.
 *
 * The cost is that a cap no longer serialises into the JSON Schema. Emitting a number that means
 * something else in a form that serialises is not a better trade.
 */
/**
 * Whether this column's cap needs the registered kind.
 *
 * Shared with the preamble check on purpose. They were two copies of the same condition and they
 * drifted the moment one changed: an array of `varchar(n)` emitted `[Kind]` into a file that did
 * not import it, so the module threw the moment anything loaded it.
 */
function tbNeedsCapKind(c: Column): boolean {
  // Not excluded for an array column: the cap describes the *element*, and the array wraps it
  // after, so `varchar(50).array()` caps each entry.
  return c.tsType === 'string' && !c.shape && !!(c.maxLength || c.maxBytes);
}

function tbCapExpr(c: Column, base: string): string {
  if (!tbNeedsCapKind(c)) return base;
  const branch = (desc: string, expr: string) => `Type.Unsafe<unknown>({
    [Kind]: 'DrzlRowCheck',
    description: ${JSON.stringify(desc)},
    assert: (v: any) => v == null || ${expr},
  })`;
  const out: string[] = [];
  if (c.maxLength) out.push(branch(`at most ${c.maxLength} characters`, `[...v].length <= ${c.maxLength}`));
  if (c.maxBytes) {
    out.push(branch(`at most ${c.maxBytes} bytes`, `new TextEncoder().encode(v).length <= ${c.maxBytes}`));
  }
  // Intersected onto the field rather than onto the object, so a per-field comparison can still
  // see the constraint. On the object it was invisible to the parity harness, which reads
  // `schema.properties[col]`, and 133 columns looked unconstrained that were not.
  return out.length ? `Type.Intersect([${base}, ${out.join(', ')}])` : base;
}

function tbLengthBranches(lengths: LengthCheck[], cols: Column[]): string[] {
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
      return `Type.Unsafe<unknown>({
    [Kind]: 'DrzlRowCheck',
    description: ${msg},
    assert: (o: any) => o == null || ${v} == null || [...${v}].length ${OPS[k.operator]} ${k.value},
  })`;
    });
}

function tbWrapRows(
  objectExpr: string,
  rows: RowCheck[],
  cols: Column[],
  lengths: LengthCheck[] = []
): string {
  const present = new Set(cols.map((c) => c.name));
  const OPS: Record<RowCheck['operator'], string> = {
    '>=': '>=',
    '>': '>',
    '<=': '<=',
    '<': '<',
    '=': '===',
    '<>': '!==',
  };
  const branches = rows
    // A check naming a column this mode does not carry cannot be evaluated: an insert schema
    // omits generated columns, so the comparison would read undefined and always pass or fail.
    .filter((r) => present.has(r.left) && present.has(r.right))
    .map((r) => {
      const l = `o[${JSON.stringify(r.left)}]`;
      const rt = `o[${JSON.stringify(r.right)}]`;
      const msg = JSON.stringify(`${r.name ? `${r.name}: ` : ''}${r.left} ${r.operator} ${r.right}`);
      // Null on either side means SQL never applied the comparison, so neither does this.
      return `Type.Unsafe<unknown>({
    [Kind]: 'DrzlRowCheck',
    description: ${msg},
    assert: (o: any) => o == null || ${l} == null || ${rt} == null || ${l} ${OPS[r.operator]} ${rt},
  })`;
    });
  const all = [...branches, ...tbLengthBranches(lengths, cols)];
  return all.length
    ? `Type.Intersect([\n  ${objectExpr},\n  ${all.join(',\n  ')},\n])`
    : objectExpr;
}

export interface TypeBoxGenerateOptions extends ValidationGenerateOptions {
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

export class TypeBoxGenerator implements ValidationRenderer<TypeBoxGenerateOptions> {
  readonly library = 'typebox' as const;
  constructor(private analysis: Analysis) {}

  async generate(opts: TypeBoxGenerateOptions) {
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

    for (const table of this.analysis.tables) {
      const filePath = path.join(out, moduleFileName(table.tsName, fileSuffix));
      const code = renderTableSchemas(table, affix, coerceDates, typedJson, !!opts.applyDefaults,
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
    const indexFormatted = await formatCode(
      buildHeader(opts.outputHeader) + this.defaultIndex(this.analysis, opts),
      indexPath,
      opts.format
    );
    await fs.writeFile(indexPath, indexFormatted, 'utf8');
    files.push(indexPath);
    return files;
  }

  renderTable(table: Table, opts?: TypeBoxGenerateOptions) {
    return renderTableSchemas(
      table,
      resolveAffix(opts),
      opts?.coerceDates ?? 'input',
      undefined,
      !!opts?.applyDefaults,
      !!opts?.duplicateFinder
    );
  }

  private defaultIndex(analysis: Analysis, opts: TypeBoxGenerateOptions) {
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

export default TypeBoxGenerator;

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
