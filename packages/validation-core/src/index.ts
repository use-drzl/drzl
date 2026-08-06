import type { Analysis, Column } from '@drzl/analyzer';
import type { ImportExtension } from './files.js';
import type { AffixOptions } from './naming.js';

export * from './checks.js';
export * from './files.js';
export * from './naming.js';

// Minimal local Table shape for codegen logic and tests
export interface Table {
  name: string;
  tsName: string;
  columns: Column[];
  primaryKey?: { columns: string[] };
}

export type ValidationLibrary = 'zod' | 'valibot' | 'arktype' | 'typebox';

export interface FormatOptions {
  enabled?: boolean;
  engine?: 'auto' | 'prettier' | 'biome';
  configPath?: string;
}

export interface ValidationGenerateOptions {
  outDir: string;
  /**
   * Path to the Drizzle schema module, as written in the config.
   *
   * Only needed by `typedJson`, which has to import the table back in order to reference the
   * type Drizzle inferred for a column.
   */
  schemaPath?: string;
  /**
   * Type `json` and `jsonb` columns from the schema instead of leaving them wide.
   *
   * `.$type<T>()` is a compile-time cast: Drizzle's implementation is literally
   * `$type() { return this }`, so the type exists only in TypeScript and nothing about it
   * survives to runtime. Every runtime-derived validator is therefore blind to it, and
   * `drizzle-orm/zod` types a json column as its generic `Json` no matter what you declared.
   *
   * A generator can do better without resolving any types itself, because Drizzle already did
   * the work: `typeof users.$inferSelect['prefs']` *is* the declared type, resolved by
   * TypeScript at the point of use. So the emitted schema references that rather than trying to
   * reconstruct it, which is why this works for generics, unions and imported interfaces alike,
   * the cases that defeat source-parsing approaches.
   *
   * Off by default: it makes the generated file import your schema module, and that coupling
   * should be a choice rather than a surprise.
   */
  typedJson?: boolean;
  /**
   * Take every column's static type from Drizzle's inference, not just the untyped ones.
   *
   * `typedJson` covers the columns that have no runtime type worth checking. This covers the
   * rest, and exists for `.$type<T>()`, which is a compile-time cast on any column at all:
   * `text().$type<'admin' | 'member'>()` is a `string` to every runtime-derived validator, so
   * `drizzle-orm/zod` and DRZL alike emitted a plain `z.string()` and the narrowing was lost.
   *
   * The runtime schema is untouched. The reference is appended with `.pipe()` rather than
   * replacing anything, so a `varchar(50)` keeps its length check and only its *type* narrows
   * from `string` to the union you declared. Nothing can narrow it at runtime, since the cast
   * leaves no trace there.
   *
   * Implies `typedJson`, since both need the schema imported back. Off by default: it adds a
   * `.pipe()` to every field, which is noise unless you use `.$type<T>()`.
   */
  typedColumns?: boolean;
  /**
   * Reproduce literal column defaults in the insert schema, so parsing fills them in.
   *
   * Off by default because it changes what parsing *returns*: `parse({})` on a table with
   * `country: text().default('GB')` yields `{ country: 'GB' }` rather than `{}`. That is usually
   * what you want from a schema that models the row, but it is a change in behaviour rather than
   * only in strictness, so it is asked for rather than assumed.
   *
   * Only literal defaults are reproduced. `defaultNow()`, `defaultRandom()` and any `sql` default
   * are evaluated by the database, and `$defaultFn` is called by Drizzle at insert time; a schema
   * that guessed at any of them would produce a different value than the one actually stored.
   *
   * `drizzle-orm/zod` reproduces none of them, literal or otherwise.
   */
  applyDefaults?: boolean;
  format?: FormatOptions;
  /**
   * What every generated file is called after the Drizzle export name, e.g. `.zod.ts`
   * yields `users.zod.ts`. The barrel derives its import specifiers from this same value,
   * so a custom suffix keeps resolving.
   */
  fileSuffix?: string;
  /**
   * How the barrel spells the extension of the files it re-exports. Defaults to `'js'`,
   * so `users.zod.ts` is imported as `./users.zod.js`, the only form that resolves under
   * every `moduleResolution` without a compiler flag. Use `'none'` for the extensionless
   * specifiers drzl emitted before 2.0.
   */
  importExtension?: ImportExtension;
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

/**
 * Whether the database generates this column's value, so it cannot be written.
 *
 * `primaryKeyColumns` is accepted for backwards compatibility and no longer consulted. It used
 * to make every primary key count as generated, which dropped it from the insert schema whether
 * or not the database supplied it. Right for a MySQL autoincrement column; wrong for a Postgres
 * `integer('id').primaryKey()`, which Postgres does not generate, and for any natural key such
 * as `text('slug').primaryKey()`. Those inserts became impossible to express: the required
 * column was simply absent, with no way to provide it.
 *
 * Being a key says nothing about who supplies the value. `isGenerated` marks a column that
 * cannot be written; `hasDefault` marks one that need not be, and those stay in the schema as
 * optional.
 */
export function isGeneratedColumn(c: Column, _primaryKeyColumns: string[] = []): boolean {
  return c.isGenerated;
}

/**
 * Whether a numeric column accepts whole numbers only.
 *
 * The analyzer states this outright from Drizzle v1's `dataType`. The fallback is what the
 * generators each used to do on their own: read "declares both bounds" as "is an integer". That
 * was true only while integers were the sole bounded type, so it is kept strictly for an
 * analysis produced before `Column.integer` existed, and never consulted when the flag is set.
 */
/**
 * Patterns for string columns whose contents the database constrains.
 *
 * Every entry was validated against Postgres through PGlite rather than reasoned about: the
 * pattern and the database agree on a pool built to include the awkward *valid* forms, because
 * the real hazard is over-rejection. A check that turns away something Postgres accepts breaks
 * working code, which is worse than the bare `string` it replaces.
 *
 * That is why there is exactly one entry. Candidates for `date`, `timestamp`, `time`, `interval`,
 * `inet`, `cidr` and `macaddr` were all built and all rejected, each by a value Postgres accepts
 * and the pattern did not:
 *
 *   date      `today`, `January 8, 1999`, `20200101`, `01/02/2020`, `infinity`
 *   time      `allballs`, `12:00:00+02`
 *   macaddr   `2020-01-01`, which Postgres pads into `20:20:00:01:00:01`
 *   inet      `10.1/16`, `::ffff:1.2.3.4`
 *   cidr      parses as `inet` and then demands zero host bits, which no regex can state
 */
export const COLUMN_FORMATS: Record<string, string> = {
  // Sign, decimals, exponents, NaN/Infinity, surrounding whitespace, and the underscore digit
  // separators and 0x/0o/0b integer literals Postgres 16 added. Agrees with Postgres on all 43
  // probes, `1_000` and `0xDEAD_beef` through to `1__0`, `_1`, `0x` and `1e+`.
  numeric:
    '^\\s*([+-]?(0[xX][0-9a-fA-F](_?[0-9a-fA-F])*|0[oO][0-7](_?[0-7])*|0[bB][01](_?[01])*)' +
    '|[+-]?(\\d(_?\\d)*(\\.(\\d(_?\\d)*)?)?|\\.\\d(_?\\d)*)([eE][+-]?\\d(_?\\d)*)?' +
    '|[+-]?(NaN|Infinity))\\s*$',
};

/**
 * Why a character limit is not `.max(n)`.
 *
 * Postgres and MySQL count `varchar(n)` in **characters**; every JavaScript validator counts
 * `.length`, which is UTF-16 code units. They agree until the text leaves the basic plane, and
 * then they do not: `varchar(10)` accepts ten emoji, and `.max(10)` refuses eight of them.
 *
 * Verified against Postgres through PGlite, for `varchar(10)`:
 *
 *   3 emoji   db accepts   .max(10) accepts
 *   8 emoji   db accepts   .max(10) REFUSES
 *  10 emoji   db accepts   .max(10) REFUSES
 *  11 emoji   db refuses   .max(10) refuses
 *
 * `[...v].length` counts code points, which is what the database counts, and matches on all four.
 * Refusing a user's emoji is the failure mode this avoids, and it is the same rule applied
 * everywhere else here: never reject what the database accepts.
 *
 * All four generators count code points. `@sinclair/typebox` and ArkType cannot say it in their
 * declarative forms, so neither uses `maxLength` or `string <= n`: TypeBox intersects a registered
 * kind onto the field and ArkType puts a Type carrying a narrow there. Both cost something,
 * TypeBox's cap no longer serialising into a JSON Schema, and emitting a number that means a
 * different measurement is not a better trade.
 *
 * MySQL's TEXT family is a byte budget rather than a character count, carried separately as
 * `maxBytes`. Two measurements on string columns in the same database, verified against a real
 * MySQL 8 on utf8mb4: `varchar(10)` takes ten emoji, `tinytext` takes 63 of them and refuses 64.
 */
export const CODEPOINT_LENGTH = '[...v].length';

export function isIntegerColumn(c: Column): boolean {
  if (typeof c.integer === 'boolean') return c.integer;
  return c.dbType === 'INTEGER' || (c.min !== undefined && c.max !== undefined);
}

export function insertColumns(table: Table): Column[] {
  return table.columns.filter((c) => !isGeneratedColumn(c));
}

/**
 * Which columns belong in an update schema.
 *
 * A primary key identifies the row rather than changing it, and a generated column cannot be
 * written at all. This asked only the first question, so every `generatedAlwaysAs` column landed
 * in the patch type. Measured against real servers: all three refuse an UPDATE naming one with any
 * value, including NULL. Postgres 428C9, MySQL 3105, SQLite "cannot UPDATE generated column". The
 * one accepted form is `SET col = DEFAULT`, which no validator can express and no Drizzle `.set()`
 * produces.
 *
 * `isGeneratedColumn` rather than `c.isGenerated`, so this and `insertColumns` cannot drift apart
 * on what counts as generated.
 */
export function updateColumns(table: Table): Column[] {
  const pkCols = table.primaryKey?.columns ?? [];
  return table.columns.filter((c) => !isGeneratedColumn(c) && !pkCols.includes(c.name));
}

export function selectColumns(table: Table): Column[] {
  return table.columns;
}

/**
 * Engines already reported as unusable in this process.
 *
 * Whether a formatter can be loaded is a fact about the environment, not about the file being
 * written, so it is reported once however many files a run emits. `drzl generate` reaches
 * `formatCode` once per table per generator, and a message repeated that many times is one nobody
 * reads.
 */
const reportedEngines = new Set<string>();

/** Which package each engine is loaded from, since the config names one and the error the other. */
const ENGINE_PACKAGE = { prettier: 'prettier', biome: '@biomejs/biome' } as const;

/**
 * Say that a formatter the config asked for by name could not be used, and why.
 *
 * The reason is the caught error's own words rather than a paraphrase, because "never installed"
 * and "installed and then threw" reach this from the same branch and nothing else distinguishes
 * them.
 *
 * The advice differs because the remedy does. Installing prettier fixes the prettier case; it is
 * an optional peer of this package and that is the whole of it. Installing `@biomejs/biome` does
 * not fix the biome case: at 2.5.7 that package declares `bin` and no `main`, `module` or
 * `exports`, so importing it as a module rejects with ERR_MODULE_NOT_FOUND whether or not it is
 * installed. Measured, against a real install of it. So the biome message points at the CLI and at
 * the other engines rather than telling anyone to install something that would not help.
 */
function reportUnusableFormatter(engine: 'prettier' | 'biome', cause: unknown): void {
  if (reportedEngines.has(engine)) return;
  reportedEngines.add(engine);
  const pkg = ENGINE_PACKAGE[engine];
  const remedy =
    engine === 'prettier'
      ? 'Install prettier, which is an optional peer of @drzl/validation-core, or set ' +
        'format.engine to "auto" to accept whatever formatter is present.'
      : 'drzl formats with Biome by importing @biomejs/biome as a module; run the Biome CLI ' +
        'over the output instead, or set format.engine to "auto" or "prettier".';
  const reason = cause instanceof Error ? cause.message : String(cause);
  console.warn(
    `[drzl] format.engine is "${engine}" but ${pkg} could not be used, so the generated files ` +
      `were left unformatted. ${remedy} Reason: ${reason}`
  );
}

/**
 * Pretty-print emitted code with whatever formatter the consumer already has.
 *
 * Both formatters are optional peers, reached at call time and never bundled. Prettier used to be
 * bundled, because tsup resolves the specifier below statically and esbuild then inlined all of
 * it: 11 MB per package across the three that had a copy of this function, roughly 32 MB for
 * anyone installing @drzl/cli. It is `--external` in every build script that can reach it, and
 * no-bundled-formatter.spec.ts builds those scripts and checks.
 *
 * An absent formatter is never fatal. A consumer with no formatter gets the code as rendered,
 * which is valid TypeScript that merely looks worse, and losing generated files at the last step
 * would be a far worse trade than losing their whitespace.
 *
 * Whether it is worth saying so depends on what was asked for, which is the difference between the
 * two branches below. `engine: 'auto'` asked for whatever happens to be installed, so finding
 * nothing is an outcome and the code comes back unchanged in silence. Naming an engine is a
 * request, and an unmet request that produces neither formatted output nor a message reads as
 * "this is fine" when it is not: the consumer configured something, it did not happen, and nothing
 * in the run says which. So a named engine that cannot be loaded warns on stderr and still returns
 * the code, rather than throwing. Throwing would lose a whole generation over whitespace, and the
 * consumer would not even be told what for: every generator branch in the CLI except the oRPC one
 * wraps its `generate()` in a catch that prints "<name> generator missing. Install with: npm
 * install @drzl/generator-<name>", so the headline would name a package they already have and the
 * real reason would arrive as a trailing detail line. Measured, with a throw wired in on purpose.
 */
export async function formatCode(code: string, filePath: string, fmt?: FormatOptions) {
  if (fmt && fmt.enabled === false) return code;
  const engine = fmt?.engine ?? 'auto';
  if (engine === 'prettier' || engine === 'auto') {
    try {
      const prettier: any = await import('prettier');
      const cfgRef = fmt?.configPath ?? filePath;
      const cfg = await prettier.resolveConfig(cfgRef).catch(() => null);
      // Returned without `await`, which is what it has always been and is load-bearing: an async
      // function adopts a returned promise outside its own try, so a prettier that loads and then
      // rejects on this code still propagates to the caller. That is an error rather than an
      // absence, and it is not this function's to swallow.
      return prettier.format(code, { ...(cfg ?? {}), parser: 'typescript', filepath: filePath });
    } catch (err) {
      if (engine === 'prettier') reportUnusableFormatter('prettier', err);
    }
  }
  if (engine === 'biome' || engine === 'auto') {
    try {
      const dynamicImport: any = Function('s', 'return import(s)');
      const biome: any = await dynamicImport('@biomejs/biome');
      if (biome?.formatContent) {
        const res = await biome.formatContent(code, { filePath });
        const out = res && (res.content || res.formatted);
        if (typeof out === 'string') return out;
        throw new Error('@biomejs/biome formatContent returned no formatted content');
      }
      // Biome has shipped this entry point under both names. The second was only ever tried by
      // the oRPC generator's private copy of this function, and is kept here so that folding the
      // copies together takes nothing away from it.
      if (biome?.format) {
        const res = await biome.format(code, { filePath });
        if (typeof res === 'string') return res;
        throw new Error('@biomejs/biome format returned no formatted content');
      }
      throw new Error('@biomejs/biome exposes neither formatContent nor format');
    } catch (err) {
      if (engine === 'biome') reportUnusableFormatter('biome', err);
    }
  }
  return code;
}

// Re-export analyzer types for test/type convenience
// (Keep local Table as exported type)

export * from './duplicates';
