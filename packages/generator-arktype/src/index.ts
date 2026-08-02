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
      // `== n` for a Postgres `bit(n)`, `<= n` for a MySQL `binary(n)`.
      if (!s.length) return '/^[01]*$/';
      return `/^[01]*$/ & string ${s.exact ? '==' : '<='} ${s.length}`;
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
      // ArkType compares bigints against bigint literals, and a 64 bit bound cannot be written
      // as a number without rounding, so the range is left unstated rather than stated wrongly.
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

function atField(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  sets: ColumnSet[] = [],
  applyDefault = false,
  cardinalities: CardinalityCheck[] = []
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
    // optional, so it replaces the `?` suffix rather than combining with it.
    if (mode === 'insert' && applyDefault && c.defaultValue !== undefined) {
      t = `${t} = ${JSON.stringify(c.defaultValue)}`;
    } else if (mode === 'update' || c.nullable || c.hasDefault) {
      t = `${t}?`;
    }
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
      const dsl = atField(c, mode, coerceDates, checks, sets, applyDefaults, cardinalities);
      const caps = atCapNarrows(c);
      if (!caps) return `  ${JSON.stringify(c.name)}: ${JSON.stringify(dsl)},`;
      // A Type instance rather than a DSL string, because neither cap is expressible in the DSL:
      // `string <= n` counts UTF-16 code units, which agrees with neither database. ArkType marks
      // optionality on the key when the value is a Type, so the `?` moves there.
      const optional = dsl.endsWith('?');
      const inner = optional ? dsl.slice(0, -1) : dsl;
      const key = JSON.stringify(optional ? `${c.name}?` : c.name);
      return `  ${key}: type(${JSON.stringify(inner)})${caps},`;
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
 * Column caps as narrows: characters for `varchar(n)`, bytes for MySQL's TEXT family.
 *
 * Neither is expressible in the string DSL. `string <= n` counts UTF-16 code units, which is a
 * third measurement, agreeing with neither. Both databases count `varchar(n)` in characters and
 * MySQL counts `tinytext` in bytes, so both are written out here rather than approximated.
 */
function atCapNarrows(c: Column): string {
  if (c.tsType !== 'string' || c.arrayDimensions || c.shape) return '';
  const out: string[] = [];
  if (c.maxLength) {
    const msg = JSON.stringify(`at most ${c.maxLength} characters`);
    out.push(`.narrow((v, ctx) => v == null || [...v].length <= ${c.maxLength} || ctx.mustBe(${msg}))`);
  }
  if (c.maxBytes) {
    const msg = JSON.stringify(`at most ${c.maxBytes} bytes`);
    out.push(
      `.narrow((v, ctx) => v == null || new TextEncoder().encode(v).length <= ${c.maxBytes} || ctx.mustBe(${msg}))`
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
  applyDefaults = false
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
`;
}

export interface ArkTypeGenerateOptions extends ValidationGenerateOptions {
  outputHeader?: { enabled?: boolean; text?: string };
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
      const code = renderTableSchemas(table, affix, coerceDates, !!opts.applyDefaults);
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
    return renderTableSchemas(table, resolveAffix(opts), opts?.coerceDates ?? 'input');
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
