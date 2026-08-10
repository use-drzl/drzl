import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Analysis, Column } from '@drzl/analyzer';
import type { BrandingOption } from './branding.js';
import { parseCheck } from './checks.js';
import type { FileSink } from './emit.js';
import type { ImportExtension } from './files.js';
import type { AffixOptions } from './naming.js';

export * from './branding.js';
export * from './checks.js';
export * from './constraints.js';
export * from './emit.js';
export * from './files.js';
export * from './meta.js';
export * from './naming.js';
export * from './nested.js';

// Minimal local Table shape for codegen logic and tests
export interface Table {
  name: string;
  tsName: string;
  columns: Column[];
  primaryKey?: { columns: string[] };
  /**
   * The declared CHECK constraints, because one of them decides whether a column is nullable.
   *
   * Structurally the analyzer's `Check[]`, and here rather than only there because the three
   * column selectors below have to read it and this is the shape they are declared against.
   */
  checks?: { name?: string; expression?: string }[];
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
  /**
   * Give every primary key, and every foreign key pointing at one, a nominal type, so a
   * `users.id` cannot be passed where a `posts.id` is wanted.
   *
   * Type level only. The brand is a marker in the inferred type and nothing at all at runtime:
   * measured on zod 4.4.3, `.brand()` returns the same schema object it was called on, and the
   * parsed value of `1` is `1`, so two branded ids holding `1` are still `===`. Nothing about
   * what a schema accepts or rejects changes here, and nothing is added to the bundle.
   *
   * Off by default, because it changes the inferred type of every consumer of the select
   * schemas. Turning it on will produce errors in code that was passing the wrong id around,
   * which is the point, but it is a change to existing call sites rather than an addition.
   *
   * `{ foreignKeys: false }` brands only the keys themselves. See `BrandingOptions`.
   *
   * TypeBox has no brand helper, so the marker there is an intersection carried by
   * `Type.Unsafe<T>`, which leaves the runtime schema byte-identical. See the docs page.
   */
  branded?: BrandingOption;
  emit?: {
    select?: boolean;
    insert?: boolean;
    update?: boolean;
  };
  /**
   * Where the generated files go, when that is not the filesystem.
   *
   * Omitted, they go to disk exactly as before. Passed, every write and every `mkdir` is handed to
   * the sink instead, which is what `drzl generate --dry-run` and `drzl generate --check` are
   * built on: both need the content a run would produce without the run producing it. See
   * `emit.ts` for why this is an option rather than an interception of `node:fs/promises`.
   */
  fileSink?: FileSink;
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
 * The list is short for that reason. Candidates for `date`, `timestamp`, `time`, `interval`,
 * `inet`, `cidr` and `macaddr` were all built and all rejected, each by a value Postgres accepts
 * and the pattern did not:
 *
 *   date      `today`, `January 8, 1999`, `20200101`, `01/02/2020`, `infinity`
 *   time      `allballs`, `12:00:00+02`
 *   macaddr   `2020-01-01`, which Postgres pads into `20:20:00:01:00:01`
 *   inet      `10.1/16`, `::ffff:1.2.3.4`
 *   cidr      parses as `inet` and then demands zero host bits, which no regex can state
 *
 * **One key per dialect where the servers disagree.** `numeric` is Postgres's alone, and the
 * analyzer withholds it from SQLite for that reason. The two `bigint` entries are the case where
 * withholding is not enough, because both dialects have a real answer and the answers contradict
 * each other in both directions. See them below.
 */
export const COLUMN_FORMATS: Record<string, string> = {
  // Sign, decimals, exponents, NaN/Infinity, surrounding whitespace, and the underscore digit
  // separators and 0x/0o/0b integer literals Postgres 16 added. Agrees with Postgres on all 43
  // probes, `1_000` and `0xDEAD_beef` through to `1__0`, `_1`, `0x` and `1e+`.
  numeric:
    '^\\s*([+-]?(0[xX][0-9a-fA-F](_?[0-9a-fA-F])*|0[oO][0-7](_?[0-7])*|0[bB][01](_?[01])*)' +
    '|[+-]?(\\d(_?\\d)*(\\.(\\d(_?\\d)*)?)?|\\.\\d(_?\\d)*)([eE][+-]?\\d(_?\\d)*)?' +
    '|[+-]?(NaN|Infinity))\\s*$',

  // What Postgres itself parses into a `bigint`, for a `bigint({ mode: 'string' })` column whose
  // value goes to the server as text. `int8in` is a pure integer parser: an optional sign against
  // the digits, decimal or a `0x`/`0o`/`0b` literal, single `_` separators between digits and one
  // permitted directly after the base prefix, leading zeros, and surrounding whitespace. Measured
  // against a real Postgres through PGlite over 16160 probes, boundary sweeps and random shapes:
  // **zero** values the server takes and this refuses.
  //
  // Two things it deliberately does not say.
  //
  // **The magnitude.** Every one of the 4474 probes this admits and the server refuses is a value
  // outside the signed 64 bit range, and nothing else: the syntax half is complete. The exact
  // bound is expressible, since leading zeros and separators make it a per-digit ladder rather
  // than a digit count, and it was built and verified at 16160/16160 against the server. It is
  // not shipped, because at 1237 characters and around twenty alternation branches it exhausts
  // ArkType's type-level instantiation budget: that generator states a format as a regex literal
  // inside the type expression, and the emitted module then fails to compile with TS2589.
  // Measured on arktype 2.2.3, this 101-character pattern compiles and the ladder does not, as
  // `COLUMN_FORMATS.numeric` at 176 characters already does not. Emitting a module that does not
  // typecheck is a worse failure than the bound it would buy, and the bound is unreachable by any
  // value the probe pools carry. The ArkType defect is already reported and carved out of the
  // parity gate's typecheck stage; when it is fixed, the ladder is what goes here.
  //
  // **Whitespace exactly.** Postgres pads with C `isspace`, which is the six ASCII characters, and
  // JS `\s` also admits NBSP and the Unicode spaces. That admits a handful of strings the server
  // refuses, which is the safe direction, and it is what `numeric` above already does.
  pgBigint:
    '^\\s*[+-]?(\\d(_?\\d)*|0[xX]_?[\\da-fA-F](_?[\\da-fA-F])*' +
    '|0[oO]_?[0-7](_?[0-7])*|0[bB]_?[01](_?[01])*)\\s*$',

  // The same column on MySQL, which parses it as a *decimal number* and then rounds. Measured
  // against MySQL 8.4.11: `'12.5'` stores 13, `'1.5'` stores 2, `'.5'` stores 1, `'1e3'` stores
  // 1000, and `'92233720368547758070e-1'` stores the int64 maximum. It refuses the two spellings
  // Postgres takes, `'0x1f'` and `'1_000'`, both as "Data truncated". So no single pattern serves
  // both servers: their union admits `'12.5'` on Postgres, which is one of the fourteen values
  // that made this a defect, and their intersection turns away values each server really stores.
  //
  // Shared by the signed and the unsigned spelling, and this is why neither magnitude nor sign is
  // stated here: the value the range applies to is the *rounded* one, so the text does not
  // determine whether it fits. `'9223372036854775807.4'` is stored and `'9223372036854775807.6'`
  // is refused; on a `bigint unsigned`, `'-0.4'` and `'-1e-1'` are both stored as 0 while `'-0.5'`
  // is refused. A pattern cannot do that arithmetic, and guessing at it turns away working rows.
  // Over 3319 probes against each of a signed and an unsigned column: zero values the server takes
  // and this refuses.
  mysqlBigint: '^\\s*[+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d*)?\\s*$',

  // A temporal column carried as text, and the only thing that can be said about one: it is not
  // blank. Unanchored on purpose, so it means "holds at least one non-whitespace character".
  //
  // Everything stronger was refused for the reason the analyzer's `format` comment gives: Postgres
  // reads 'today', 'January 8, 1999', '01/08/1999' and '20200101' as dates, so a date-shaped
  // pattern turns away rows the server stores. This one turns away nothing: measured on Postgres,
  // every temporal type accepts a valid value with surrounding whitespace and refuses '' and ' '
  // alike, so the set this refuses and the set the server refuses are the same set. The analyzer
  // decides which columns carry it, per engine and per type, since MySQL's `time` takes a blank
  // and silently stores 00:00:00.
  temporalText: '\\S',
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

/**
 * The non-finite doubles the emitted schema must *refuse*, as the analyzer stated them.
 *
 * The other reading of the same two flags, and not the negation of `nonFiniteAccepted`. Three
 * states, because a column that was measured and refused the value is a different thing from a
 * column nobody measured: `true` is stored and returned, `false` is offered and refused, absent is
 * unstated. `nonFiniteAccepted` reads `=== true` and this reads `=== false`, so an unstated column
 * answers no to both and every generator leaves it exactly as its library renders it.
 *
 * The distinction is load-bearing rather than tidy. MySQL and SQLite both leave a `real` unbounded,
 * and MySQL answers `ER_WARN_DATA_OUT_OF_RANGE` for an infinity where SQLite stores it and hands it
 * back. Reading "not accepted" as "refuse it" would have made one schema right and the other wrong
 * from the same reading, and the SQLite half is filed separately because that engine also turns
 * `NaN` into NULL and a column needs both halves of that answer or none.
 *
 * Guarded on `tsType` exactly as its sibling is, so a stale analysis carrying the flags on a string
 * or a shaped column cannot put a numeric predicate beside a `z.string()`.
 *
 * What each generator does with a yes is its own: `z.number()` and `Type.Number()` already refuse
 * every non-finite number with no bound at all, measured, so they emit nothing and read this only
 * through the tests that pin that. `v.number()` and ArkType's `number` take both infinities, so
 * those two add a finite predicate wherever no bound already holds one back. Effect builds on
 * `Schema.Finite` unconditionally and needs nothing either.
 */
export function nonFiniteRefused(c: Column): { nan: boolean; infinity: boolean } {
  if (c.tsType !== 'number' || c.shape) return { nan: false, infinity: false };
  return { nan: c.allowsNaN === false, infinity: c.allowsInfinity === false };
}

/**
 * The columns a `CHECK (col IS NOT NULL)` on this table forbids NULL in.
 *
 * The whole constraint has to parse, not just the clause: `email IS NOT NULL OR my_fn(email) > 1`
 * holds those four words and forbids nothing, because either branch may be the one that holds.
 * `parseCheck` refuses that expression outright, so nothing here has to know about it.
 */
function notNullByCheck(table: Table): Set<string> {
  const out = new Set<string>();
  for (const k of table.checks ?? []) {
    const parsed = parseCheck(k.expression, k.name);
    if (!parsed.ok) continue;
    for (const n of parsed.nulls ?? []) if (n.notNull) out.add(n.column);
  }
  return out;
}

/**
 * The column list with any `IS NOT NULL` CHECK applied to it.
 *
 * `IS NOT NULL` is the one constraint in this parser that cannot be a predicate on the field. A
 * check is emitted *inside* the nullable wrapper, precisely because SQL never applies a comparison
 * to NULL and a CHECK passes on it; this constraint is the statement that NULL is not allowed, so
 * the only place it can be said is the wrapper. Saying it here rather than in each generator is
 * what makes it one answer: all five read their columns through these three functions, and none of
 * them has to learn a new kind of check to honour it.
 *
 * Applied in every mode. On select the database guarantees the column is there; on insert a row
 * omitting a nullable column with no default writes NULL, which the constraint forbids, so the
 * field becomes required; on update `SET col = NULL` is refused for the same reason.
 *
 * Returns the same array when nothing narrows, so the ordinary table pays one `Set` and no copy.
 */
function withCheckNullability(table: Table, cols: Column[]): Column[] {
  const notNull = notNullByCheck(table);
  if (!notNull.size) return cols;
  return cols.map((c) => (c.nullable && notNull.has(c.name) ? { ...c, nullable: false } : c));
}

export function insertColumns(table: Table): Column[] {
  return withCheckNullability(
    table,
    table.columns.filter((c) => !isGeneratedColumn(c))
  );
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
  return withCheckNullability(
    table,
    table.columns.filter((c) => !isGeneratedColumn(c) && !pkCols.includes(c.name))
  );
}

export function selectColumns(table: Table): Column[] {
  return withCheckNullability(table, table.columns);
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
 * Whether a resolved manifest path belongs to a project's installed dependencies.
 *
 * Resolving a package is normally the same question as having it installed, and on Node and Deno
 * it is: their resolvers walk `node_modules` and answer a missing package with MODULE_NOT_FOUND.
 * Bun's does not. When nothing is found it auto-installs the package from npm and resolves into
 * its own global cache, so `require.resolve('@biomejs/biome/package.json')` succeeds under Bun
 * against a project whose package.json has never mentioned Biome. Measured under Bun 1.3.14:
 *
 *   node   -> MODULE_NOT_FOUND
 *   deno   -> MODULE_NOT_FOUND
 *   bun    -> /home/<user>/.bun/install/cache/@biomejs/biome@2.5.7@@@1/package.json
 *
 * That made `drzl generate` emit Biome-formatted files under Bun and unformatted files under Node
 * from the same schema and the same config, so `generate --check` under Node called every file
 * out of date; and it fetched a package, plus a multi-megabyte native binary, from the network in
 * the middle of codegen. It was not stable within Bun either, since whether the auto-install fired
 * depended on the state of a cache outside the project.
 *
 * A `node_modules` path segment is the discriminator, and it is exact rather than a heuristic:
 * npm, pnpm's `.pnpm` store and Yarn PnP's zip and unplugged paths all reach a package through
 * one, and Bun's auto-install cache is the one shape that does not, because it is not a project
 * install. Under Node and Deno this can never fire, since their resolvers have no other kind of
 * path to return, so it costs those runtimes nothing. A Bun project that really does install
 * Biome resolves through its `node_modules` like everyone else and still formats.
 */
export function isProjectInstallPath(manifestPath: string): boolean {
  return manifestPath.split(path.sep).includes('node_modules');
}

/**
 * Find `@biomejs/biome`'s manifest, anchoring each candidate directory in its own `createRequire`.
 *
 * The obvious spelling is one `createRequire` and `resolve(spec, { paths: [startDir, cwd] })`,
 * which is what this was. Node honours that list; Bun does not. Measured under Bun 1.3.14 with
 * Biome genuinely installed in the project and the output directory outside it (an absolute
 * `outDir`), which is the exact case `paths` was added for:
 *
 *   node -> /app/node_modules/@biomejs/biome/package.json      (fell back to cwd, correct)
 *   bun  -> ~/.bun/install/cache/@biomejs/biome@2.5.7@@@1/...  (auto-installed instead)
 *
 * So Bun never tried the second entry: rather than walking on to `process.cwd()`, it answered the
 * miss from `startDir` by fetching the package from npm. Anchoring a separate `createRequire` at
 * each candidate asks the question Bun does answer correctly, one directory at a time, and both
 * runtimes then find the same project install. Order is preserved from the `paths` array it
 * replaces: the directory being written into wins, and the process working directory is the
 * fallback.
 *
 * A resolution that is not a project install is skipped rather than returned, so Bun's
 * auto-install cache never wins over a real install further up. See `isProjectInstallPath`.
 */
function biomeManifest(startDir: string): string {
  const anchors = [startDir, process.cwd()];
  let lastError: unknown;
  for (const anchor of anchors) {
    let resolved: string;
    try {
      const require_ = createRequire(pathToFileURL(path.join(anchor, 'noop.js')));
      resolved = require_.resolve('@biomejs/biome/package.json');
    } catch (err) {
      lastError = err;
      continue;
    }
    if (isProjectInstallPath(resolved)) return resolved;
    lastError = new Error(
      `@biomejs/biome resolved to ${resolved}, which is not part of this project's installed ` +
        'dependencies. Add @biomejs/biome to the project to format with it.'
    );
  }
  throw lastError ?? new Error('@biomejs/biome could not be resolved');
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
  const manifestPath = biomeManifest(startDir);
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
