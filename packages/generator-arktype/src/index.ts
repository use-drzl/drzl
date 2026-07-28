import type { Analysis, Table, Column } from '@drzl/analyzer';
import type {
  ResolvedAffix,
  ValidationRenderer,
  ValidationGenerateOptions,
} from '@drzl/validation-core';
import {
  insertColumns,
  updateColumns,
  selectColumns,
  formatCode,
  resolveAffix,
  schemaName,
  typeName,
} from '@drzl/validation-core';

type Mode = 'insert' | 'update' | 'select';

function atDateType(
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
): string {
  if (coerceDates === 'none') return 'Date';
  if (coerceDates === 'all') return 'Date | string';
  // 'input'
  return mode === 'select' ? 'Date' : 'Date | string';
}

function atTypeForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
): string {
  if (c.enumValues && c.enumValues.length) {
    return c.enumValues.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(' | ');
  }
  switch (c.tsType) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'bigint':
      return 'bigint';
    case 'boolean':
      return 'boolean';
    case 'Date':
      return atDateType(mode, coerceDates);
    case 'Uint8Array':
      return 'Uint8Array';
    case 'any':
      return 'unknown';
    default:
      return 'unknown';
  }
}

function atField(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
): string {
  let t = atTypeForColumn(c, mode, coerceDates);
  if (c.nullable) t = `(${t} | null)`;
  if (mode !== 'select') {
    if (mode === 'update' || c.nullable || c.hasDefault) t = `${t}?`;
  }
  return t;
}

function renderObjectShape(
  cols: Column[],
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>
) {
  return cols
    .map((c) => `  ${JSON.stringify(c.name)}: ${JSON.stringify(atField(c, mode, coerceDates))},`)
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
  return `import { type } from 'arktype';

export const ${insertSchema} = type({
${bodyInsert}
});

export const ${updateSchema} = type({
${bodyUpdate}
});

export const ${selectSchema} = type({
${bodySelect}
});

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
    const fileSuffix = opts.fileSuffix ?? '.arktype.ts';
    for (const table of this.analysis.tables) {
      // File names deliberately stay on the raw Drizzle export name: affixes and tableCase
      // rename identifiers, never modules, so the barrel and importPath keep resolving.
      const filePath = path.join(out, `${table.tsName}${fileSuffix}`);
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

  renderTable(table: Table, opts?: ArkTypeGenerateOptions) {
    return renderTableSchemas(table, resolveAffix(opts), opts?.coerceDates ?? 'input');
  }

  private defaultIndex(analysis: Analysis, _opts: ArkTypeGenerateOptions) {
    const exports = analysis.tables.map((t) => `export * from './${t.tsName}.arktype';`).join('\n');
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
