import type { Analysis, Table, Column } from '@drzl/analyzer';
import type {
  ResolvedAffix,
  ValidationRenderer,
  ValidationGenerateOptions,
  RowCheck,
} from '@drzl/validation-core';
import type { CardinalityCheck, ColumnCheck, ColumnSet, LengthCheck } from '@drzl/validation-core';
import {
  COLUMN_FORMATS,
  insertColumns,
  isIntegerColumn,
  parseCheck,
  resolveConfiguredImport,
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
const DEFAULT_FILE_SUFFIX = '.valibot.ts';

function vDateExpr(
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
): string {
  if (coerceDates === 'none') return 'v.date()';
  const coercer = `v.pipe(v.string(), v.transform((s) => new Date(s)))`;
  if (coerceDates === 'all') return `v.union([v.date(), ${coercer}])`;
  // 'input'
  return mode === 'select' ? 'v.date()' : `v.union([v.date(), ${coercer}])`;
}

/**
 * `v.minValue(min), v.maxValue(max)` for a column declaring an integer range, else nothing.
 *
 * Bounds arrive as decimal strings, since a 64 bit bound cannot round-trip through a JS number,
 * so they are pasted rather than parsed. `literal` spells each one, which is the only difference
 * between the number and bigint cases.
 */
function vBounds(c: Column, literal: (v: string) => string): string[] {
  if (c.min === undefined || c.max === undefined) return [];
  return [`v.minValue(${literal(c.min)})`, `v.maxValue(${literal(c.max)})`];
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
  return checks
    .filter((k) => k.column === c.name)
    .map((k) => {
      const rhs = k.kind === 'string' ? JSON.stringify(k.value) : k.value;
      const shown = k.kind === 'string' ? `'${k.value}'` : k.value;
      const msg = JSON.stringify(`${k.name ? `${k.name}: ` : ''}${c.name} ${k.operator} ${shown}`);
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
function vShapeExpr(c: Column): string | undefined {
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
    case 'numberVector':
      return s.length
        ? `v.pipe(v.array(v.number()), v.length(${s.length}))`
        : 'v.array(v.number())';
    case 'bitstring': {
      // `v.length` for a Postgres `bit(n)`, `v.maxLength` for a MySQL `binary(n)`.
      const len = s.length
        ? `, ${s.exact ? `v.length(${s.length})` : `v.maxLength(${s.length})`}`
        : '';
      return `v.pipe(v.string(), v.regex(/^[01]*$/)${len})`;
    }
  }
}

/**
 * `v.check(...)` actions for the `length(col)` constraints naming this column.
 *
 * Code points, because Postgres counts characters. See the zod generator.
 */
function vLengthChecks(c: Column, lengths: LengthCheck[]): string[] {
  if (c.arrayDimensions || c.shape) return [];
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
      const msg = JSON.stringify(
        `${k.name ? `${k.name}: ` : ''}length(${c.name}) ${k.operator} ${k.value}`
      );
      return `v.check((val) => [...val].length ${OPS[k.operator]} ${k.value}, ${msg})`;
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
  const shaped = vShapeExpr(c);
  if (shaped) return shaped;
  // `CHECK (status IN ('a', 'b'))` constrains the column to a set, which is what a picklist is.
  const set = sets.find((x) => x.column === c.name);
  if (set) {
    return set.kind === 'string'
      ? `v.picklist([${set.values.map((v) => JSON.stringify(v)).join(', ')}] as const)`
      : `v.union([${set.values.map((v) => `v.literal(${v})`).join(', ')}])`;
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
      // Not `v.maxLength(n)`, which counts UTF-16 units where the column counts characters. See
      // the zod generator and `CODEPOINT_LENGTH` in validation-core.
      return piped(
        'v.string()',
        c.maxLength
          ? [
              `v.check((val) => [...val].length <= ${c.maxLength}, 'at most ${c.maxLength} characters')`,
            ]
          : []
      );
    case 'number': {
      return piped('v.number()', [
        ...(isIntegerColumn(c) ? ['v.integer()'] : []),
        ...vBounds(c, (v) => v),
      ]);
    }
    case 'bigint': {
      // Bounds must be bigint literals: a 64 bit bound written as a number rounds.
      return piped(
        'v.bigint()',
        vBounds(c, (v) => `${v}n`)
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
  narrowRef?: string
): string {
  let expr = vExprForColumn(c, mode, coerceDates, checks, sets, lengths);
  // Drizzle keeps an array on the element's own column class, so everything above describes the
  // element and the wrapping belongs out here, after the bounds and length limits are attached.
  for (let i = 0; i < (c.arrayDimensions ?? 0); i++) expr = `v.array(${expr})`;
  // After the wrapping, because this constrains the array rather than an element.
  const card = vCardinalityChecks(c, cardinalities);
  if (card.length) expr = `v.pipe(${expr}, ${card.join(', ')})`;
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
  return vNarrow(expr, narrowRef);
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
  typedColumns?: { table: string; mode: 'insert' | 'select' }
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
            : undefined
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
  return rows
    // A check naming a column this mode does not carry cannot be evaluated: an insert schema
    // omits generated columns, so the comparison would read undefined and always pass or fail.
    .filter((r) => present.has(r.left) && present.has(r.right))
    .map((r) => {
      const l = `o[${JSON.stringify(r.left)}]`;
      const rt = `o[${JSON.stringify(r.right)}]`;
      const msg = JSON.stringify(`${r.name ? `${r.name}: ` : ''}${r.left} ${r.operator} ${r.right}`);
      return `v.check((o) => ${l} == null || ${rt} == null || ${l} ${OPS[r.operator]} ${rt}, ${msg})`;
    });
}

function renderTableSchemas(
  table: Table,
  affix: ResolvedAffix,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  applyDefaults = false,
  typedColumns?: { schemaSpecifier: string }
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
  // than guessed at, exactly as in the Zod generator.
  const parsedChecks = (table.checks ?? []).map((k) => parseCheck(k.expression, k.name));
  const checks = parsedChecks.flatMap((p) => (p.ok ? p.checks : []));
  const sets = parsedChecks.flatMap((p) => (p.ok ? (p.sets ?? []) : []));
  const rows = parsedChecks.flatMap((p) => (p.ok ? (p.rows ?? []) : []));
  const lengths = parsedChecks.flatMap((p) => (p.ok ? (p.lengths ?? []) : []));
  const cardinalities = parsedChecks.flatMap((p) => (p.ok ? (p.cardinalities ?? []) : []));
  const tj = typedColumns ? { table: T, mode: 'select' as const } : undefined;
  const tjInsert = typedColumns ? { table: T, mode: 'insert' as const } : undefined;
  // A type-only import: erased at build time, so it adds no runtime dependency on the schema
  // module and cannot create an import cycle.
  const schemaImport = typedColumns
    ? `import type { ${T} } from '${typedColumns.schemaSpecifier}';\n`
    : '';

  const bodyInsert = renderObjectShape(
    insertCols,
    'insert',
    coerceDates,
    checks,
    sets,
    applyDefaults,
    lengths,
    cardinalities,
    tjInsert
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
    tjInsert
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
    tj
  );
  // Emitted only where a json column exists, so a file without one gains nothing unused.
  const needsJson = [...insertCols, ...updateCols, ...selectCols].some(
    (c) => c.shape?.kind === 'json'
  );

  return `import * as v from 'valibot';
import type { InferInput, InferOutput } from 'valibot';
${schemaImport}${needsJson ? `\n${JSON_PREAMBLE}` : ''}
export const ${insertSchema} = ${wrapRows(`v.object({\n${bodyInsert}\n})`, rows, insertCols)};

export const ${updateSchema} = ${wrapRows(`v.object({\n${bodyUpdate}\n})`, rows, updateCols)};

export const ${selectSchema} = ${wrapRows(`v.object({\n${bodySelect}\n})`, rows, selectCols)};

export type ${insertType} = InferInput<typeof ${insertSchema}>;
export type ${updateType} = InferInput<typeof ${updateSchema}>;
export type ${selectType} = InferOutput<typeof ${selectSchema}>;
`;
}

export interface ValibotGenerateOptions extends ValidationGenerateOptions {
  outputHeader?: { enabled?: boolean; text?: string };
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
    // File names deliberately stay on the raw Drizzle export name: affixes and tableCase
    // rename identifiers, never modules, so the barrel and importPath keep resolving.
    for (const table of this.analysis.tables) {
      const filePath = path.join(out, moduleFileName(table.tsName, fileSuffix));
      const code = renderTableSchemas(
        table,
        affix,
        coerceDates,
        !!opts.applyDefaults,
        typedColumns
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
    return renderTableSchemas(table, resolveAffix(opts), opts?.coerceDates ?? 'input');
  }

  private defaultIndex(analysis: Analysis, opts: ValibotGenerateOptions) {
    const fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;
    const exports = analysis.tables
      .map((t) => `export * from '${moduleSpecifier(t.tsName, fileSuffix, opts.importExtension)}';`)
      .join('\n');
    return exports + '\n';
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
