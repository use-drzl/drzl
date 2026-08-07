import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Analysis, Column } from '@drzl/analyzer';
import type { ImportExtension } from './files.js';
import type { AffixOptions } from './naming.js';

export * from './checks.js';
export * from './files.js';
export * from './naming.js';
export * from './nested.js';

// Minimal local Table shape for codegen logic and tests
export interface Table {
  name: string;
  tsName: string;
  columns: Column[];
  primaryKey?: { columns: string[] };
}

export type ValidationLibrary = 'zod' | 'valibot' | 'arktype' | 'typebox' | 'effect';

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
  /**
   * Also emit `NestedInsert<Table>` and `NestedSelect<Table>`: the table's own schema plus one key
   * per relation, so `{ ...user, posts: [...] }` can be validated whole.
   *
   * Nothing in the Drizzle validator ecosystem describes this payload. Measured across both majors
   * and all four libraries, `createInsertSchema(users)` emits column keys only, and
   * `db.insert(users).values({ name, posts: [...] })` drops the `posts` key without a word rather
   * than refusing it, so the children are silently never written.
   *
   * Off by default, like every other option that adds bytes to the consumer's bundle. See
   * `NestedMode` in `@drzl/validation-core` for why there is no nested update schema, and
   * `KINDS_BY_MODE` for why a `one` relation appears on select and not on insert.
   */
  nestedSchemas?: boolean;
  /**
   * How many levels of children a nested schema describes. Defaults to 1, capped at
   * `MAX_NESTED_DEPTH`.
   *
   * Nesting is expanded inline rather than by reference, so this multiplies the emitted size: a
   * schema whose tables average R relations emits R^depth child shapes per root table. It is also
   * what terminates a cycle, since `users -> posts -> users` simply stops here.
   */
  nestedDepth?: number;
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
  /**
   * One table's schemas, without the nested variants even under `nestedSchemas`.
   *
   * Structural rather than an omission: relations live on the `Analysis` and this is handed a
   * `Table`, so there is nothing here to read them from. `typedJson` is absent for the same
   * reason. Nothing but the generators' own tests calls this; `generate` is the path that emits.
   */
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
 * Which strings a `mode: 'date'` column may coerce, for `coerceDates`.
 *
 * A string matching this may be handed to `new Date`; one that does not is left alone and fails
 * the `Date` check that follows it. This narrows coercion, it does not remove it: `coerceDates`
 * still decides *where* a string is coerced at all.
 *
 * Two things are refused, both measured against a real Postgres through PGlite.
 *
 * **A string that is only a number.** V8's legacy date parser reads a bare digit run as a year,
 * or as `month.day`, so `new Date('12.5')`, `new Date('0101')` and `new Date('010')` are all real
 * dates. Postgres refuses those three, so the insert passed validation and then failed at the
 * server, which is the outcome an Insert schema exists to prevent.
 *
 * The obvious justification for the rule, that Postgres refuses a bare number, is false. Postgres
 * reads a six or eight digit run as a compact `YYMMDD` / `YYYYMMDD` date and takes it happily. The
 * real justification is stronger: where both parsers accept such a string they never agree on
 * which date it is. Measured over every all-digit string in the probe set that both accept, ten of
 * them, the two answers differed every single time and none of the ten agreed:
 *
 *   '250101'    Postgres 2025-01-01    V8 the year 250101
 *   '241231'    Postgres 2024-12-31    V8 the year 241231
 *   '121212'    Postgres 2012-12-12    V8 the year 121212
 *   '000101'    Postgres 2000-01-01    V8 0100-12-31
 *
 * So coercing a bare number is not merely permissive. Either the value reaches the server and is
 * rejected, or it is silently written as a different date than the one the database would have
 * stored. Refusing to coerce it is the only answer that is never wrong.
 *
 * **A string starting with a sign.** `new Date('+2020-01-01')` and `new Date('-2020-01-01')` are
 * valid dates in V8 and Postgres refuses both. It also costs nothing: the sign-prefixed strings
 * Postgres does take are `infinity`, `+infinity` and `-infinity`, and no JS `Date` represents
 * those, so a `mode: 'date'` column could never carry one whatever this pattern said.
 *
 * Not to be confused with the rejected `date` entry in `COLUMN_FORMATS` above. That would have
 * constrained a string-typed date column, whose value goes to the server verbatim, so refusing
 * `20200101` or `infinity` there would turn away a working insert. Here the string is on its way
 * into a JS `Date`, and neither of those survives the trip.
 *
 * Verified still coercing, both parsers agreeing on the date: `2020-01-01`,
 * `2020-01-01T00:00:00Z`, `1999-01-08 04:05:06`, `01/02/2020`, `January 8, 1999`, `2020-1-5` and
 * `  2020-01-01  `.
 */
export const COERCIBLE_DATE_STRING = '^(?!\\s*[+-])(?!\\s*\\d*\\.?\\d*(?:[eE][+-]?\\d+)?\\s*$)';

/**
 * Whether a coercion really produced a date, as an expression over an emitted `Date`.
 *
 * `COERCIBLE_DATE_STRING` above is a gate on the *shape* of the input string and this is a gate on
 * the *result*. They are two different questions and the second one was not being asked at all:
 * `'hello'`, `'zzz'`, `'25:99:99'`, `'not-a-uuid'`, `'10.0.0.1'`, a 300-character run of `x` and a
 * string of emoji are none of them bare numbers, so the pattern passed every one of them through,
 * `new Date` returned an Invalid Date for every one of them, and nothing looked. Postgres refuses
 * all of them, so validation passed and the INSERT then failed at the server.
 *
 * **An Invalid Date is still a `Date`.** `new Date('hello') instanceof Date` is true and
 * `typeof` says `object`, so no instance check and no type guard can tell the two apart. The
 * timestamp is the only thing that differs, and it is `NaN`, which is also why the test cannot be
 * `d.getTime() !== NaN`: nothing is equal to `NaN`, including itself.
 *
 * The zod generator has always asked this without needing to say so, because
 * `z.preprocess(coerce, z.date())` validates what came *out* of the coercion and `z.date()` fails
 * an Invalid Date. The other three either accept the string or transform it and then stop looking,
 * so each states this in whatever form its library has: valibot as a `v.check` after the
 * transform, ArkType as a `.narrow`, TypeBox as the `assert` of a registered kind. One expression,
 * shared, so the four cannot drift on what "is a date" means.
 *
 * `'12:00:00'` is the one probe worth naming, because V8 and Postgres could have disagreed about
 * it and do not. `new Date('12:00:00')` is an Invalid Date, and measured against Postgres through
 * PGlite, `'12:00:00'` is refused by `date`, `timestamp` and `timestamptz` alike with
 * `invalid input syntax`. The three Postgres types that do take it are `time`, `timetz` and
 * `interval`, and none of those is ever a `mode: 'date'` column. So refusing it is right on both
 * counts. `'25:99:99'` is refused by both as well, Postgres with `date/time field value out of
 * range`.
 */
export function parsesToADate(expr: string): string {
  return `!Number.isNaN(${expr}.getTime())`;
}

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
 * All five generators count code points. `@sinclair/typebox`, ArkType and Effect cannot say it in
 * their declarative forms, so none of them uses `maxLength` or `string <= n`: TypeBox intersects a
 * registered kind onto the field, ArkType puts a Type carrying a narrow there, and Effect pipes a
 * `Schema.filter`. Each costs the same thing, the cap no longer serialising into a JSON Schema, and
 * emitting a number that means a different measurement is not a better trade.
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

/**
 * The non-finite doubles the emitted schema must admit beside the column's range, as the analyzer
 * stated them.
 *
 * One reading of two flags, shared so that five generators cannot drift on what they mean, and not
 * a shared *rendering*: the five libraries do not need the same repair. `z.number()` and
 * `Type.Number()` refuse `NaN` and both infinities outright, `v.number()` and ArkType's `number`
 * refuse only `NaN`, and any bound at all makes all of those refuse the infinities, so what each
 * has to add depends on the library and on whether the column carries a range.
 *
 * Effect is the one that runs the other way, measured on 3.22.1: `Schema.Number` *accepts* `NaN`
 * and both infinities, so the flags being false is what makes that generator emit something. It
 * builds on `Schema.Finite` rather than `Schema.Number` for exactly that reason, and does so
 * unconditionally rather than leaning on the range, since `Infinity >= 0` is true and a lower bound
 * alone therefore excludes nothing.
 *
 * Guarded on `tsType` so an enum, a shape or a string can never pick these up from a stale
 * analysis. `@drzl/generator-json-schema` deliberately does not call this at all: JSON has no `NaN`
 * and no `Infinity`, so there is nothing for a JSON Schema to admit.
 *
 * A numeric CHECK folded into one end of the column's range does not take a branch away, in any of
 * the five. That is a decision rather than an oversight, and it is deliberately the loose one: what
 * Postgres does with `CHECK (c >= 0)` and a `NaN` was not measured for this change, and dropping
 * the branch on a column that carries a CHECK would put back, for that column, exactly the
 * read-path failure this exists to remove.
 */
export function nonFiniteAccepted(c: Column): { nan: boolean; infinity: boolean } {
  if (c.tsType !== 'number' || c.shape) return { nan: false, infinity: false };
  return { nan: c.allowsNaN === true, infinity: c.allowsInfinity === true };
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
 * Installing the named package is the remedy in both cases, which was not true of biome until the
 * engine started running the Biome binary rather than importing the package: `@biomejs/biome`
 * publishes `bin` and no module entry point, so the old advice had to send people to the CLI by
 * hand. See `formatBiome` below for what was measured.
 */
function reportUnusableFormatter(engine: 'prettier' | 'biome', cause: unknown): void {
  if (reportedEngines.has(engine)) return;
  reportedEngines.add(engine);
  const pkg = ENGINE_PACKAGE[engine];
  const remedy =
    engine === 'prettier'
      ? 'Install prettier, which is an optional peer of @drzl/validation-core, or set ' +
        'format.engine to "auto" to accept whatever formatter is present.'
      : 'Install @biomejs/biome in the project being generated into, or set format.engine to ' +
        '"auto" or "prettier".';
  const reason = cause instanceof Error ? cause.message : String(cause);
  console.warn(
    `[drzl] format.engine is "${engine}" but ${pkg} could not be used, so the generated files ` +
      `were left unformatted. ${remedy} Reason: ${reason}`
  );
}

/**
 * The nearest directory at or above `from` that exists.
 *
 * A child process cannot be spawned into a directory that is not there: `spawn` fails with ENOENT
 * before the command runs. Every generator calls `fs.mkdir(out, { recursive: true })` before its
 * first `formatCode`, so in a real run the output directory exists, but `formatCode` is exported
 * and its own tests pass paths under a temp directory that was never created. Walking up is what
 * makes that a formatted file rather than a spawn failure. `path.dirname` is its own fixed point at
 * the filesystem root, which is what terminates this.
 */
function nearestExistingDir(from: string): string {
  let dir = path.dirname(path.resolve(from));
  for (;;) {
    try {
      if (statSync(dir).isDirectory()) return dir;
    } catch {
      // Not there, or not readable. Either way the parent is the next thing to try.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

/**
 * Locate the Biome executable belonging to the project being generated into.
 *
 * `@biomejs/biome` cannot be imported. Its manifest declares `bin` and carries no `main`, no
 * `module`, no `exports` and no `types`, and the tarball has no `index.js` for Node's legacy main
 * resolution to fall back to, so `import('@biomejs/biome')` rejects with ERR_MODULE_NOT_FOUND on a
 * complete and correct install. That is not a recent regression: it holds at 1.0.0, 1.5.3, 1.9.4,
 * 2.0.6, 2.4.16 and 2.5.7, measured by installing each one and importing it, so the engine had
 * never formatted anything for anybody. `bin` is what the package publishes, so `bin` is what this
 * uses.
 *
 * The manifest is reachable as a subpath *because* there is no `exports` field to gate it, which is
 * the same fact from the other side: `require.resolve('@biomejs/biome')` throws MODULE_NOT_FOUND
 * against an install where `require.resolve('@biomejs/biome/package.json')` succeeds.
 *
 * Resolution starts from the consumer's project rather than from this package, which is why
 * `@biomejs/biome` is not declared as a peer here the way prettier is. Prettier is imported, so it
 * has to resolve from validation-core's own location and pnpm links it there only because the peer
 * entry exists. Biome is spawned, and the install that matters is the one in the project the files
 * are being written into.
 */
function biomeBinary(startDir: string): string {
  const require_ = createRequire(pathToFileURL(path.join(startDir, 'noop.js')));
  // `paths` covers the case where the output directory sits outside the project, as it does for an
  // absolute `outDir`; the process working directory is then the better anchor.
  const manifestPath = require_.resolve('@biomejs/biome/package.json', {
    paths: [startDir, process.cwd()],
  });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // A string at 1.5.3 and below, an object from 1.9.4 on. Both shapes are still installable.
  const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.biome;
  if (typeof relative !== 'string') {
    throw new Error(`@biomejs/biome at ${manifestPath} declares no biome binary`);
  }
  const binary = path.resolve(path.dirname(manifestPath), relative);
  if (!existsSync(binary)) {
    throw new Error(`@biomejs/biome declares a binary at ${relative}, and there is nothing there`);
  }
  return binary;
}

/**
 * Format one file's worth of code by piping it through `biome format --stdin-file-path`.
 *
 * Supported as far back as 1.5.3, checked by running it there and at 2.5.7.
 *
 * Three things about the child are load-bearing, each measured against the real 2.5.7 binary rather
 * than assumed:
 *
 * 1. Only the exit status may be believed. Biome exits 1 and *echoes the input back on stdout* when
 *    the formatter is disabled in the consumer's biome.json, and again for a file extension it does
 *    not format. Code that returned stdout whenever stdout was non-empty would hand back unformatted
 *    text as though it had been formatted, and nothing downstream inspects whitespace.
 * 2. stdout is collected by hand rather than through `execFile`, whose default 1 MB `maxBuffer`
 *    truncated a 2.9 MB result to exactly 1048576 bytes and failed with
 *    ERR_CHILD_PROCESS_STDIO_MAXBUFFER. Generated barrels reach that size.
 * 3. The child runs in the directory the file is being written to. Biome finds biome.json by
 *    walking up from its working directory and not from `--stdin-file-path`, so the working
 *    directory is the whole of whose configuration applies; running the same command from an
 *    unrelated directory picked up a different biome.json and exited non-zero. That also makes the
 *    consumer's config apply without passing `--config-path`, whose argument means a directory at
 *    1.x and either a directory or a file at 2.x, and so cannot be passed compatibly.
 *
 * `process.execPath` rather than the file's shebang: `bin/biome` is a Node launcher at every
 * published version, and a shebang means nothing on Windows.
 */
function formatBiome(code: string, filePath: string, configAnchor: string): Promise<string> {
  const cwd = nearestExistingDir(configAnchor);
  const binary = biomeBinary(nearestExistingDir(filePath));
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [binary, 'format', `--stdin-file-path=${path.basename(filePath)}`],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => (err += chunk));
    child.on('error', reject);
    // Biome can exit before reading all of stdin, and an unhandled EPIPE on a child's stdin is an
    // uncaught exception rather than a rejected promise. The exit status is what decides the
    // outcome, so the write failing is not separately interesting.
    child.stdin.on('error', () => {});
    child.on('close', (status) => {
      if (status !== 0) {
        const detail = err.trim().split('\n')[0] || out.trim().split('\n')[0] || 'no output';
        reject(new Error(`biome format exited with ${status}: ${detail}`));
        return;
      }
      // Empty stdout is the right answer for empty input, measured, and never for anything else.
      // This return value is written straight to disk, so a formatter that swallowed the file would
      // truncate it to nothing, which is a worse outcome than any formatting failure.
      if (out === '' && code !== '') {
        reject(new Error('biome format exited 0 but returned nothing'));
        return;
      }
      resolve(out);
    });
    child.stdin.end(code);
  });
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
 * the code, rather than throwing. Throwing would lose a whole generation over whitespace, which is
 * a bad trade even now that the CLI reports the reason faithfully: it used to answer any throw at
 * all with "<name> generator missing. Install with: npm install @drzl/generator-<name>", naming a
 * package the consumer already had, and it now separates an unresolvable package from a generator
 * that ran and failed.
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
      // `filePath` names the file, which is where the extension comes from; the second argument is
      // only ever used to decide which directory to run Biome in, and so honours `configPath` the
      // same way the prettier branch above hands it to `resolveConfig`.
      return await formatBiome(code, filePath, fmt?.configPath ?? filePath);
    } catch (err) {
      if (engine === 'biome') reportUnusableFormatter('biome', err);
    }
  }
  return code;
}

// Re-export analyzer types for test/type convenience
// (Keep local Table as exported type)

export * from './duplicates';
