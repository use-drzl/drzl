import type { Analysis, Column, Table } from '@drzl/analyzer';
import type { ValidationGenerateOptions, ValidationRenderer } from '@drzl/validation-core';
import { formatCode, insertColumns, selectColumns, updateColumns } from '@drzl/validation-core';

type Mode = 'insert' | 'update' | 'select';

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
      return 'z.string()';
    case 'number':
      return c.dbType === 'INTEGER' ? 'z.number().int()' : 'z.number()';
    case 'bigint':
      return 'z.bigint()';
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
  suffix = 'Schema',
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
) {
  const T = table.tsName;
  const insertCols = insertColumns(table);
  const updateCols = updateColumns(table);
  const selectCols = selectColumns(table);
  const bodyInsert = renderObjectShape(insertCols, 'insert', coerceDates);
  const bodyUpdate = renderObjectShape(updateCols, 'update', coerceDates);
  const bodySelect = renderObjectShape(selectCols, 'select', coerceDates);
  return `import { z } from 'zod';

export const Insert${T}${suffix} = z.object({
${bodyInsert}
});

export const Update${T}${suffix} = z.object({
${bodyUpdate}
});

export const Select${T}${suffix} = z.object({
${bodySelect}
});

export type Insert${T}Input = z.input<typeof Insert${T}${suffix}>;
export type Update${T}Input = z.input<typeof Update${T}${suffix}>;
export type Select${T}Output = z.output<typeof Select${T}${suffix}>;
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
    const suffix = opts.schemaSuffix ?? 'Schema';
    const coerceDates = opts.coerceDates ?? 'input';
    const fileSuffix = opts.fileSuffix ?? '.zod.ts';
    for (const table of this.analysis.tables) {
      const filePath = path.join(out, `${table.tsName}${fileSuffix}`);
      const code = renderTableSchemas(table, suffix, coerceDates);
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
    return renderTableSchemas(table, opts?.schemaSuffix ?? 'Schema', opts?.coerceDates ?? 'input');
  }

  renderIndex?(analysis: Analysis, opts?: ZodGenerateOptions): string;

  private defaultIndex(analysis: Analysis, _opts: ZodGenerateOptions) {
    const exports = analysis.tables.map((t) => `export * from './${t.tsName}.zod';`).join('\n');
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
