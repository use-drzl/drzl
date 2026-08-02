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
): { lower?: string; upper?: string; equals?: string } {
  let lower = c.min !== undefined ? `${c.min} <=` : undefined;
  let upper = c.max !== undefined ? `<= ${c.max}` : undefined;
  let equals: string | undefined;

  for (const k of checks.filter((x) => x.column === c.name && x.kind === 'number')) {
    if (k.operator === '>=') lower = `${k.value} <=`;
    else if (k.operator === '>') lower = `${k.value} <`;
    else if (k.operator === '<=') upper = `<= ${k.value}`;
    else if (k.operator === '<') upper = `< ${k.value}`;
    else if (k.operator === '=') equals = k.value;
  }
  return { lower, upper, equals };
}

function atTypeForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = []
): string {
  if (c.enumValues && c.enumValues.length) {
    return c.enumValues.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(' | ');
  }
  switch (c.tsType) {
    // ArkType constrains inside its string DSL rather than by chaining. Each form below was
    // checked against arktype itself, accepting a valid value and rejecting an invalid one,
    // because an expression it cannot parse throws at import and takes the router with it.
    case 'string': {
      // An equality check pins the value, which ArkType states as a literal type.
      const eq = checks.find((k) => k.column === c.name && k.operator === '=' && k.kind === 'string');
      if (eq) return `'${eq.value.replace(/'/g, "\\'")}'`;
      if (c.format === 'uuid') return 'string.uuid';
      return c.maxLength ? `string <= ${c.maxLength}` : 'string';
    }
    case 'number': {
      const { lower, upper, equals } = atNarrowRange(c, checks);
      if (equals !== undefined) return equals;
      // `min <= number <= max` already implies an integer range here, and ArkType has no way to
      // write both that and `number.integer` in one expression, so the bound is the stronger
      // statement and is preferred where present.
      if (lower && upper) return `${lower} number ${upper}`;
      if (lower) return `${lower} number`;
      if (upper) return `number ${upper}`;
      return c.dbType === 'INTEGER' ? 'number.integer' : 'number';
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
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = []
): string {
  let t = atTypeForColumn(c, mode, coerceDates, checks);
  if (c.nullable) t = `(${t} | null)`;
  if (mode !== 'select') {
    if (mode === 'update' || c.nullable || c.hasDefault) t = `${t}?`;
  }
  return t;
}

function renderObjectShape(
  cols: Column[],
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = []
) {
  return cols
    .map((c) => `  ${JSON.stringify(c.name)}: ${JSON.stringify(atField(c, mode, coerceDates, checks))},`)
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
  const checks = (table.checks ?? []).flatMap((k) => {
    const parsed = parseCheck(k.expression, k.name);
    return parsed.ok ? parsed.checks : [];
  });
  const bodyInsert = renderObjectShape(insertCols, 'insert', coerceDates, checks);
  const bodyUpdate = renderObjectShape(updateCols, 'update', coerceDates, checks);
  const bodySelect = renderObjectShape(selectCols, 'select', coerceDates, checks);
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
