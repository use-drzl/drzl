import type { Analysis, Column, Table } from '@drzl/analyzer';
import type {
  ResolvedAffix,
  ValidationGenerateOptions,
  ValidationRenderer,
} from '@drzl/validation-core';
import {
  formatCode,
  insertColumns,
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

function zodExprForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
): string {
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
      // The presence of an integer range is what marks a column as an integer, not `dbType`.
      // Gating on `dbType === 'INTEGER'` missed `bigint({ mode: 'number' })`, whose dbType is
      // BIGINT while its value really is a JS number.
      const isInt = c.dbType === 'INTEGER' || (c.min !== undefined && c.max !== undefined);
      const base = isInt ? 'z.number().int()' : 'z.number()';
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
      return 'z.any()';
    default:
      return 'z.unknown()';
  }
}

function zodField(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
): string {
  let expr = zodExprForColumn(c, mode, coerceDates);
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
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
) {
  return cols
    .map((c) => `  ${JSON.stringify(c.name)}: ${zodField(c, mode, coerceDates)},`)
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
  const bodyInsert = renderObjectShape(insertCols, 'insert', coerceDates);
  const bodyUpdate = renderObjectShape(updateCols, 'update', coerceDates);
  const bodySelect = renderObjectShape(selectCols, 'select', coerceDates);
  return `import { z } from 'zod';

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
