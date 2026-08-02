import type { Analysis, Column, Table } from '@drzl/analyzer';
import type {
  ResolvedAffix,
  ValidationGenerateOptions,
  ValidationRenderer,
} from '@drzl/validation-core';
import type { ColumnCheck } from '@drzl/validation-core';
import {
  formatCode,
  parseCheck,
  resolveConfiguredImport,
  insertColumns,
  isIntegerColumn,
  moduleFileName,
  moduleSpecifier,
  resolveAffix,
  schemaName,
  selectColumns,
  typeName,
  updateColumns,
} from '@drzl/validation-core';

type Mode = 'insert' | 'update' | 'select';

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
function numericBounds(c: Column, literal: (v: string) => string): string {
  if (c.min === undefined || c.max === undefined) return '';
  return `.gte(${literal(c.min)}).lte(${literal(c.max)})`;
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
function checkRefinements(c: Column, checks: ColumnCheck[]): string {
  // A parsed check compares this column to a scalar literal, which says nothing usable about an
  // array or a tuple. Emitting one anyway was actively harmful: `CHECK (tags = '{}')` became
  // `.refine((v) => v === '{}')` against a `string[]`, which no value can satisfy, so the schema
  // rejected every row.
  if (c.arrayDimensions || c.shape) return '';

  const mine = checks.filter((k) => k.column === c.name);
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
function shapeExpr(c: Column, typedJsonRef?: string): string | undefined {
  const s = c.shape;
  if (!s) return undefined;
  switch (s.kind) {
    case 'json':
      // `typedJson` still wins: the type Drizzle inferred is narrower than "any JSON".
      if (typedJsonRef) return `z.custom<${typedJsonRef}>()`;
      // Zod's own JSON value space. `z.any()` accepted `undefined`, `NaN`, `Infinity`, bigints,
      // Dates and Buffers, none of which survive the round trip through the column.
      return 'z.json()';
    case 'buffer':
      // `Uint8Array` rather than `Buffer`, which is the one place the output is deliberately
      // wider than `drizzle-orm/zod`. A Buffer is a Uint8Array, so everything official accepts
      // is accepted here; the reverse is not true. Reasons for the wider check: it needs no
      // `@types/node` and so survives an edge or browser build, `Buffer` is not defined in those
      // runtimes at all and `v instanceof Buffer` would throw rather than fail, and it makes a
      // Postgres `bytea` and a SQLite `blob` validate identically instead of by dialect.
      return 'z.instanceof(Uint8Array)';
    case 'tuple':
      return `z.tuple([${Array.from({ length: s.length }, () => 'z.number()').join(', ')}])`;
    case 'numberVector':
      return `z.array(z.number())${s.length ? `.length(${s.length})` : ''}`;
    case 'bitstring':
      return `z.string().regex(/^[01]*$/)${s.length ? `.length(${s.length})` : ''}`;
  }
}

function zodExprForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  typedJsonRef?: string
): string {
  const shaped = shapeExpr(c, typedJsonRef);
  if (shaped) return shaped;
  if (c.enumValues && c.enumValues.length) {
    const vals = c.enumValues.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(', ');
    return `z.enum([${vals}] as const)`;
  }
  switch (c.tsType) {
    case 'string':
      // A uuid is a string with a fixed shape, so the format supersedes any length: stacking
      // `.max(36)` on top would restate what the format already guarantees.
      if (c.format === 'uuid') return 'z.uuid()';
      return c.maxLength ? `z.string().max(${c.maxLength})` : 'z.string()';
    case 'number': {
      const base = isIntegerColumn(c) ? 'z.number().int()' : 'z.number()';
      return base + numericBounds(c, (v) => v);
    }
    case 'bigint':
      // Bounds have to be bigint literals. A 64 bit bound written as a plain number rounds, so
      // `.lte(9223372036854775807)` would silently become `.lte(9223372036854775808)`.
      return 'z.bigint()' + numericBounds(c, (v) => `${v}n`);
    case 'boolean':
      return 'z.boolean()';
    case 'Date':
      if (coerceDates === 'all') return 'z.coerce.date()';
      if (coerceDates === 'none') return 'z.date()';
      // 'input'
      return mode === 'select' ? 'z.date()' : 'z.coerce.date()';
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
  typedJsonRef?: string
): string {
  let expr = zodExprForColumn(c, mode, coerceDates, typedJsonRef);
  // `.array()` does not give the column its own class in Drizzle, so everything above describes
  // the *element*. Length limits and integer bounds belong there, which is why the wrapping
  // happens out here rather than inside.
  for (let i = 0; i < (c.arrayDimensions ?? 0); i++) expr = `z.array(${expr})`;
  // Before nullability on purpose. A SQL CHECK passes when it evaluates to TRUE *or NULL*, so
  // wrapping the constrained type in `.nullable()` reproduces that exactly: null skips the
  // check, as the database does.
  expr += checkRefinements(c, checks);
  // For selects, nullable columns should allow null values
  if (c.nullable) {
    expr = `${expr}.nullable()`;
  }
  if (mode === 'insert') {
    // Omit generated columns at callsite; for remaining fields,
    // allow optional when nullable or has default.
    if (c.nullable || c.hasDefault) expr = `${expr}.optional()`;
  } else if (mode === 'update') {
    // All update fields are optional; preserve nullability
    expr = `${expr}.optional()`;
  }
  return expr;
}

function renderObjectShape(
  cols: Column[],
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  typedJson?: { table: string; mode: 'insert' | 'select' }
) {
  return cols
    .map((c) => {
      // Only json-ish columns get a reference; everything else already has a real type.
      const ref =
        typedJson && c.tsType === 'any'
          ? `typeof ${typedJson.table}.$infer${typedJson.mode === 'insert' ? 'Insert' : 'Select'}[${JSON.stringify(c.name)}]`
          : undefined;
      return `  ${JSON.stringify(c.name)}: ${zodField(c, mode, coerceDates, checks, ref)},`;
    })
    .join('\n');
}

function renderTableSchemas(
  table: Table,
  affix: ResolvedAffix,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  typedJson?: { schemaSpecifier: string }
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
  const checks = (table.checks ?? []).flatMap((k) => {
    const parsed = parseCheck(k.expression, k.name);
    return parsed.ok ? parsed.checks : [];
  });
  // Insert and select can disagree: a json column with a default is optional on insert, so its
  // inferred type differs. Each shape therefore references the matching inference.
  const tj = typedJson ? { table: table.tsName, mode: 'select' as const } : undefined;
  const tjInsert = typedJson ? { table: table.tsName, mode: 'insert' as const } : undefined;
  const bodyInsert = renderObjectShape(insertCols, 'insert', coerceDates, checks, tjInsert);
  const bodyUpdate = renderObjectShape(updateCols, 'update', coerceDates, checks, tjInsert);
  const bodySelect = renderObjectShape(selectCols, 'select', coerceDates, checks, tj);
  // A type-only import: it disappears at build time, so this adds no runtime dependency on the
  // schema module and cannot create an import cycle at runtime.
  const schemaImport = typedJson
    ? `import type { ${table.tsName} } from '${typedJson.schemaSpecifier}';\n`
    : '';
  return `import { z } from 'zod';
${schemaImport}
export const ${insertSchema} = z.object({
${bodyInsert}
});

export const ${updateSchema} = z.object({
${bodyUpdate}
});

export const ${selectSchema} = z.object({
${bodySelect}
});

export type ${insertType} = z.input<typeof ${insertSchema}>;
export type ${updateType} = z.input<typeof ${updateSchema}>;
export type ${selectType} = z.output<typeof ${selectSchema}>;
`;
}

export interface ZodGenerateOptions extends ValidationGenerateOptions {
  outputHeader?: { enabled?: boolean; text?: string };
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
    const typedJson =
      opts.typedJson && opts.schemaPath
        ? {
            schemaSpecifier: resolveConfiguredImport(
              opts.schemaPath,
              out,
              process.cwd(),
              opts.importExtension
            ),
          }
        : undefined;
    if (opts.typedJson && !opts.schemaPath) {
      console.warn(
        '[drzl] typedJson was requested but the schema path is unknown, so json columns keep their wide type.'
      );
    }
    // File names deliberately stay on the raw Drizzle export name: affixes and tableCase
    // rename identifiers, never modules, so the barrel and importPath keep resolving.
    for (const table of this.analysis.tables) {
      const filePath = path.join(out, moduleFileName(table.tsName, fileSuffix));
      const code = renderTableSchemas(table, affix, coerceDates, typedJson);
      const formatted = await formatCode(
        buildHeader(opts.outputHeader) + code,
        filePath,
        opts.format
      );
      await fs.writeFile(filePath, formatted, 'utf8');
      files.push(filePath);
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
    return renderTableSchemas(table, resolveAffix(opts), opts?.coerceDates ?? 'input');
  }

  renderIndex?(analysis: Analysis, opts?: ZodGenerateOptions): string;

  private defaultIndex(analysis: Analysis, opts: ZodGenerateOptions) {
    const fileSuffix = opts.fileSuffix ?? DEFAULT_FILE_SUFFIX;
    const exports = analysis.tables
      .map((t) => `export * from '${moduleSpecifier(t.tsName, fileSuffix, opts.importExtension)}';`)
      .join('\n');
    return exports + '\n';
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
