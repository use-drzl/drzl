import type { Analysis, Table, Column } from '@drzl/analyzer';
import type {
  ColumnCheck,
  ResolvedAffix,
  ValidationRenderer,
  ValidationGenerateOptions,
} from '@drzl/validation-core';
import {
  formatCode,
  insertColumns,
  moduleFileName,
  moduleSpecifier,
  parseCheck,
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

function tbExprForColumn(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  typedJsonRef?: string
): string {
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
      const base: Array<[string, string]> = c.format === 'uuid'
        ? [['pattern', JSON.stringify(UUID_PATTERN)]]
        : c.maxLength
          ? [['maxLength', String(c.maxLength)]]
          : [];
      return `Type.String(${renderOptions(merged(base))})`;
    }
    case 'number': {
      // An integer range is what marks the column as an integer; dbType alone misses
      // `bigint({ mode: 'number' })`, whose value really is a JS number.
      const isInt = c.dbType === 'INTEGER' || (c.min !== undefined && c.max !== undefined);
      const o = renderOptions(merged(tbBounds(c)));
      return isInt ? `Type.Integer(${o})` : `Type.Number(${o})`;
    }
    case 'bigint':
      // TypeBox compares bigints against bigint values, and a 64 bit bound cannot be written as
      // a JSON Schema number without rounding, so the range is left unstated rather than wrong.
      return 'Type.BigInt()';
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

function tbField(
  c: Column,
  mode: Mode,
  coerceDates: NonNullable<ValidationGenerateOptions['coerceDates']>,
  checks: ColumnCheck[] = [],
  typedJsonRef?: string
): string {
  let expr = tbExprForColumn(c, mode, coerceDates, checks, typedJsonRef);
  // Nullability wraps the constrained type, so null skips the constraint. That reproduces SQL,
  // where a CHECK passes when it evaluates to TRUE or NULL.
  if (c.nullable) expr = `Type.Union([${expr}, Type.Null()])`;
  if (mode !== 'select') {
    if (mode === 'update' || c.nullable || c.hasDefault) expr = `Type.Optional(${expr})`;
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
      const ref =
        typedJson && c.tsType === 'any'
          ? `(typeof ${typedJson.table}.$infer${typedJson.mode === 'insert' ? 'Insert' : 'Select'})[${JSON.stringify(c.name)}]`
          : undefined;
      return `  ${JSON.stringify(c.name)}: ${tbField(c, mode, coerceDates, checks, ref)},`;
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

  // Only checks the shared parser understands with certainty. Ambiguous ones are skipped rather
  // than guessed at, identically to the other validation generators.
  const checks = (table.checks ?? []).flatMap((k) => {
    const parsed = parseCheck(k.expression, k.name);
    return parsed.ok ? parsed.checks : [];
  });

  const tj = typedJson ? { table: T, mode: 'select' as const } : undefined;
  const tjInsert = typedJson ? { table: T, mode: 'insert' as const } : undefined;
  const bodyInsert = renderObjectShape(insertCols, 'insert', coerceDates, checks, tjInsert);
  const bodyUpdate = renderObjectShape(updateCols, 'update', coerceDates, checks, tjInsert);
  const bodySelect = renderObjectShape(selectCols, 'select', coerceDates, checks, tj);

  const schemaImport = typedJson
    ? `import type { ${T} } from '${typedJson.schemaSpecifier}';\n`
    : '';

  return `import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
${schemaImport}
export const ${insertSchema} = Type.Object({
${bodyInsert}
});

export const ${updateSchema} = Type.Object({
${bodyUpdate}
});

export const ${selectSchema} = Type.Object({
${bodySelect}
});

export type ${insertType} = Static<typeof ${insertSchema}>;
export type ${updateType} = Static<typeof ${updateSchema}>;
export type ${selectType} = Static<typeof ${selectSchema}>;
`;
}

export interface TypeBoxGenerateOptions extends ValidationGenerateOptions {
  outputHeader?: { enabled?: boolean; text?: string };
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
    return renderTableSchemas(table, resolveAffix(opts), opts?.coerceDates ?? 'input');
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
