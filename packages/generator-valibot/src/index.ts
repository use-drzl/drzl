import type { Analysis, Table, Column } from '@drzl/analyzer';
import type { ValidationRenderer, ValidationGenerateOptions } from '@drzl/validation-core';
import { insertColumns, updateColumns, selectColumns, formatCode } from '@drzl/validation-core';

type Mode = 'insert' | 'update' | 'select';

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

function vExprForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
): string {
  if (c.enumValues && c.enumValues.length) {
    const vals = c.enumValues.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(', ');
    // picklist is a common valibot helper for string enums
    return `v.picklist([${vals}] as const)`;
  }
  switch (c.tsType) {
    case 'string':
      return 'v.string()';
    case 'number':
      return 'v.number()';
    case 'bigint':
      return 'v.bigint()';
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
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
): string {
  let expr = vExprForColumn(c, mode, coerceDates);
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
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
) {
  return cols
    .map((c) => `  ${JSON.stringify(c.name)}: ${vField(c, mode, coerceDates)},`)
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
  return `import * as v from 'valibot';
import type { InferInput, InferOutput } from 'valibot';

export const Insert${T}${suffix} = v.object({
${bodyInsert}
});

export const Update${T}${suffix} = v.object({
${bodyUpdate}
});

export const Select${T}${suffix} = v.object({
${bodySelect}
});

export type Insert${T}Input = InferInput<typeof Insert${T}${suffix}>;
export type Update${T}Input = InferInput<typeof Update${T}${suffix}>;
export type Select${T}Output = InferOutput<typeof Select${T}${suffix}>;
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
    const suffix = opts.schemaSuffix ?? 'Schema';
    const coerceDates = opts.coerceDates ?? 'input';
    const fileSuffix = opts.fileSuffix ?? '.valibot.ts';
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
    return renderTableSchemas(table, opts?.schemaSuffix ?? 'Schema', opts?.coerceDates ?? 'input');
  }

  private defaultIndex(analysis: Analysis, _opts: ValibotGenerateOptions) {
    const exports = analysis.tables.map((t) => `export * from './${t.tsName}.valibot';`).join('\n');
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
