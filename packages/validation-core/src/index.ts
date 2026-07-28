import type { Analysis, Column } from '@drzl/analyzer';
import type { AffixOptions } from './naming.js';

export * from './files.js';
export * from './naming.js';

// Minimal local Table shape for codegen logic and tests
export interface Table {
  name: string;
  tsName: string;
  columns: Column[];
  primaryKey?: { columns: string[] };
}

export type ValidationLibrary = 'zod' | 'valibot' | 'arktype';

export interface FormatOptions {
  enabled?: boolean;
  engine?: 'auto' | 'prettier' | 'biome';
  configPath?: string;
}

export interface ValidationGenerateOptions {
  outDir: string;
  format?: FormatOptions;
  /**
   * What every generated file is called after the Drizzle export name, e.g. `.zod.ts`
   * yields `users.zod.ts`. The barrel derives its import specifiers from this same value,
   * so a custom suffix keeps resolving. `.mts` and `.cts` are written as `.mjs` and `.cjs`
   * in the specifier, because that is the only form TypeScript resolves.
   */
  fileSuffix?: string;
  schemaSuffix?: string; // e.g. Schema
  /**
   * Prefixes, suffixes and table casing for the generated identifiers. Omit it and the
   * output is identical to every previous version; `schemaSuffix` stays the fallback for
   * `affix.schema.suffix`.
   */
  affix?: AffixOptions;
  coerceDates?: 'input' | 'all' | 'none';
  emit?: {
    select?: boolean;
    insert?: boolean;
    update?: boolean;
  };
}

export interface ValidationRenderer<
  TOptions extends ValidationGenerateOptions = ValidationGenerateOptions,
> {
  readonly library: ValidationLibrary;
  renderTable(table: Table, opts?: TOptions): string;
  renderIndex?(analysis: Analysis, opts?: TOptions): string;
  generate(opts: TOptions): Promise<string[]>;
}

export function isGeneratedColumn(c: Column, primaryKeyColumns: string[]): boolean {
  return c.isGenerated || primaryKeyColumns.includes(c.name);
}

export function insertColumns(table: Table): Column[] {
  const pkCols = table.primaryKey?.columns ?? [];
  return table.columns.filter((c) => !isGeneratedColumn(c, pkCols));
}

export function updateColumns(table: Table): Column[] {
  const pkCols = table.primaryKey?.columns ?? [];
  return table.columns.filter((c) => !pkCols.includes(c.name));
}

export function selectColumns(table: Table): Column[] {
  return table.columns;
}

export async function formatCode(code: string, filePath: string, fmt?: FormatOptions) {
  if (fmt && fmt.enabled === false) return code;
  const engine = fmt?.engine ?? 'auto';
  try {
    if (engine === 'prettier' || engine === 'auto') {
      const prettier: any = await import('prettier');
      const cfgRef = fmt?.configPath ?? filePath;
      const cfg = await prettier.resolveConfig(cfgRef).catch(() => null);
      return prettier.format(code, { ...(cfg ?? {}), parser: 'typescript', filepath: filePath });
    }
  } catch {}
  try {
    if (engine === 'biome' || engine === 'auto') {
      const dynamicImport: any = Function('s', 'return import(s)');
      const biome: any = await dynamicImport('@biomejs/biome').catch(() => null);
      if (biome?.formatContent) {
        const res = await biome.formatContent(code, { filePath });
        return (res && (res.content || res.formatted)) ?? code;
      }
    }
  } catch {}
  return code;
}

// Re-export analyzer types for test/type convenience
// (Keep local Table as exported type)
