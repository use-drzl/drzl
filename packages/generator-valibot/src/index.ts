import type { Analysis, Table, Column } from '@drzl/analyzer';
import type {
  ResolvedAffix,
  ValidationRenderer,
  ValidationGenerateOptions,
} from '@drzl/validation-core';
import type { ColumnCheck } from '@drzl/validation-core';
import {
  insertColumns,
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

function vExprForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = []
): string {
  const extra = vChecks(c, checks);
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
      return piped('v.string()', c.maxLength ? [`v.maxLength(${c.maxLength})`] : []);
    case 'number': {
      // An integer range is what marks the column as an integer; dbType alone misses
      // `bigint({ mode: 'number' })`, whose value is a JS number.
      const isInt = c.dbType === 'INTEGER' || (c.min !== undefined && c.max !== undefined);
      return piped('v.number()', [...(isInt ? ['v.integer()'] : []), ...vBounds(c, (v) => v)]);
    }
    case 'bigint': {
      // Bounds must be bigint literals: a 64 bit bound written as a number rounds.
      return piped('v.bigint()', vBounds(c, (v) => `${v}n`));
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

function vField(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = []
): string {
  let expr = vExprForColumn(c, mode, coerceDates, checks);
  if (c.nullable) expr = `v.nullable(${expr})`;
  if (mode !== 'select') {
    // optional for insert when nullable/hasDefault, and for all fields in update
    if (mode === 'update' || c.nullable || c.hasDefault) expr = `v.optional(${expr})`;
  }
  return expr;
}

function renderObjectShape(
  cols: Column[],
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = []
) {
  return cols
    .map((c) => `  ${JSON.stringify(c.name)}: ${vField(c, mode, coerceDates, checks)},`)
    .join('\n');
}

function renderTableSchemas(
  table: Table,
  affix: ResolvedAffix,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
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
  const checks = (table.checks ?? []).flatMap((k) => {
    const parsed = parseCheck(k.expression, k.name);
    return parsed.ok ? parsed.checks : [];
  });
  const bodyInsert = renderObjectShape(insertCols, 'insert', coerceDates, checks);
  const bodyUpdate = renderObjectShape(updateCols, 'update', coerceDates, checks);
  const bodySelect = renderObjectShape(selectCols, 'select', coerceDates, checks);
  return `import * as v from 'valibot';
import type { InferInput, InferOutput } from 'valibot';

export const ${insertSchema} = v.object({
${bodyInsert}
});

export const ${updateSchema} = v.object({
${bodyUpdate}
});

export const ${selectSchema} = v.object({
${bodySelect}
});

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
    // File names deliberately stay on the raw Drizzle export name: affixes and tableCase
    // rename identifiers, never modules, so the barrel and importPath keep resolving.
    for (const table of this.analysis.tables) {
      const filePath = path.join(out, moduleFileName(table.tsName, fileSuffix));
      const code = renderTableSchemas(table, affix, coerceDates);
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
