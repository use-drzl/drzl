import type { Analysis, Column, Table } from '@drzl/analyzer';
import type { ImportExtension } from '@drzl/validation-core';
import {
  formatCode,
  importSpecifier,
  insertColumns,
  selectColumns,
  updateColumns,
} from '@drzl/validation-core';

/**
 * NestJS DTO and entity classes, one module per table, plus a validation pipe that runs them.
 *
 * Why DTOs and not controllers: a controller drags Nest's DI machinery into generated code
 * (modules, providers, decorators with consumer-specific tokens), and every one of those
 * decisions belongs to the consumer's app. A DTO class is the unit Nest itself scaffolds per
 * resource, it drops into any controller signature, and it is the piece a schema generator can
 * actually derive from a table.
 *
 * Why plain classes with a static schema, not class-validator decorators. Settled from the
 * registry and from measurement, not taste:
 *
 *   - Registry (checked 2026-08-08): `@nestjs/common` 11.1.28 lists `class-validator` and
 *     `class-transformer` as *optional* peers, so they are an add-on, not part of Nest.
 *     `class-validator` is 0.15.1 and active; `class-transformer`, the half that would have to
 *     convert wire values, last published 0.5.1 in November 2021. `nestjs-zod` 5.5.0 is active,
 *     which is evidence the schema-carrying-class pattern is an established Nest idiom rather
 *     than this generator's invention.
 *
 *   - The policy cannot be pinned from inside a decorator DTO. What `@IsInt()` accepts depends
 *     on the consumer's ValidationPipe options: with
 *     `transformOptions: { enableImplicitConversion: true }` the measured grid (class-validator
 *     0.15.1 under @nestjs/common 11.1.28) reads `""` as 0, `" "` as 0, `"0x10"` as 16 and
 *     `"1e5"` as 100000, the exact `Number('')` family the Hono, Express and Fastify grids
 *     exist to refuse; without it the same DTO rejects every numeric string. A static schema
 *     carries its policy with it, and no pipe option can loosen it.
 *
 *   - DRZL's presence rule needs a workaround spelling there. `@IsOptional()` treats null AND
 *     undefined as absence (measured: `{}` accepted), where the settled rule is that null is a
 *     value and absence is not. The enforcing spelling exists and is measured
 *     (`@ValidateIf((o) => o.bio !== null)` + `@IsDefined()` + the type check), but it is three
 *     decorators of workaround per nullable column.
 *
 *   - bigint has no story: measured, `@Type(() => BigInt)` leaves the string untouched (BigInt
 *     is not newable, class-transformer silently skips it) and `@IsInt()` rejects a real
 *     bigint. `@Type(() => Date)` accepts `"1"` as the year 2001.
 *
 *   - Decorators do not compile without `experimentalDecorators`: under a flag-less tsconfig
 *     TypeScript 5.9 reads them as ES decorators and property decorators fail TS1240
 *     (measured). Plain classes compile under every tsconfig, including
 *     `verbatimModuleSyntax`, which matters because generated code cannot dictate a consumer's
 *     compiler flags.
 *
 * What is emitted instead: per table, the insert, update and select schemas in the configured
 * library's own spelling (zod by default, valibot or arktype via `validation.library`), and
 * four plain classes (`Create<T>Dto`, `Update<T>Dto`, `<T>ParamsDto`, `<T>Entity`) whose fields
 * state the parsed shape and whose `static readonly schema` carries the Standard Schema v1
 * validator. The static is typed `StandardSchema<Dto>`, so a schema whose output drifts from
 * the declared fields is a compile error in the generated file itself. All three libraries
 * implement Standard Schema v1 (measured on zod 4.4.3, valibot 1.4.2, arktype 2.2.3), so one
 * emitted pipe covers them uniformly.
 *
 * `SchemaValidationPipe` reads `metatype.schema` and validates with it; a metatype without one
 * passes through untouched, so the pipe coexists with primitives and with foreign DTOs. The
 * emitted DTOs assume NO options on Nest's own ValidationPipe, because they do not use it: the
 * schemas strip undeclared keys themselves (zod and valibot by default, arktype via
 * `.onUndeclaredKey('delete')`, all three measured), which is `whitelist: true` semantics, and
 * they transform (`transform: true` semantics) by construction. If the app also runs a global
 * class-validator ValidationPipe: at its defaults it passes these DTOs through unchanged
 * (measured); with `whitelist: true` it strips every property first, because these classes
 * carry no class-validator metadata (measured: the body arrives empty); with
 * `forbidNonWhitelisted: true` it rejects them outright. The docs page carries the grid.
 *
 * Presence rule, inherited from the shared builders rather than re-decided: a nullable column
 * with no default is REQUIRED on insert. Null is a value and omitting the key is not sending
 * null. This diverges from the Hono and Express generators' inline schemas, which make such a
 * column optional on insert, and matches the JSON Schema builder the Fastify generator inlines.
 * The update schemas exclude the primary key columns, from the same shared `updateColumns`.
 *
 * Path parameters arrive as strings, and Nest's own answer, `ParseIntPipe`, was measured
 * (11.1.28): it rejects `""`, `" "`, `"0x10"`, `"1e5"`, `"1.5"` and `"1abc"`, which matches the
 * settled grid, but it also accepts `"9007199254740993"` as 9007199254740992, a silent
 * precision loss on any bigint-ranged key. The emitted params schemas therefore use the strict
 * string spellings the three route generators settled on: `^-?\d+(\.\d+)?$` transformed by
 * `Number` for a numeric key, digits kept as a string for a bigint key, strict ISO datetime
 * transformed to `Date` for a Date key, the member set for an enum key.
 *
 * Wire shapes with no JSON form, both directions measured: a Date column's insert and update
 * schemas take the strict ISO string and hand the controller a real `Date` (a JSON body cannot
 * carry one; `new Date('1')` reading as 2001 is why the spelling is strict). A bigint column
 * crosses as its decimal digits and stays a string on both sides, because
 * `JSON.stringify(1n)` throws on the way out (pinned in the runtime spec).
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /**
   * Appended to `tsName` for the file name: `'Dto'` with `procedureCase: 'kebab'` writes
   * `users-dto.ts`. Export names are fixed per class and do not take the suffix.
   */
  routerSuffix?: string;
  /** Casing applied to file names. */
  procedureCase?: Case;
}

/** The barrel's filename stem. */
export const APP_MODULE = 'index';

/** The emitted pipe module's filename stem: `SchemaValidationPipe` over Standard Schema v1. */
export const VALIDATION_MODULE = 'validation';

export interface GenerateOptions {
  outputDir: string;
  naming?: NamingOptions;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /**
   * How every relative specifier this generator invents spells its extension: the barrel's
   * re-exports and each module's type-only import of the pipe module. Defaults to `'js'`, the
   * only form that resolves under every `moduleResolution` without a compiler flag.
   */
  importExtension?: ImportExtension;
  validation?: {
    library?: 'zod' | 'valibot' | 'arktype';
  };
}

type Lib = NonNullable<NonNullable<GenerateOptions['validation']>['library']>;

type Mode = 'insert' | 'update' | 'select';

interface LibDialect {
  number: string;
  string: string;
  boolean: string;
  /** A Date that is already a Date: the select side, where the value is a handler's row. */
  date: string;
  /** A Date crossing JSON: the strict ISO string, transformed to a real Date. */
  dateInput: string;
  /** A bigint crossing JSON: its decimal digits, kept as a string on both sides. */
  bigint: string;
  unknown: string;
  enum: (values: string[]) => string;
  nullable: (base: string) => string;
  optional: (base: string) => string;
  object: (body: string) => string;
  objectInline: (body: string) => string;
  /** ArkType spells a field's type as a string literal; the others spell it as an expression. */
  fieldIsString?: boolean;
  /**
   * A path segment parsed into `tsType`. The strict spellings, taken unchanged from
   * `@drzl/generator-express`, which carries the measured grid: the idiomatic coercions are
   * built on `Number()`, and `Number('')` is 0, so `GET /users/%20` would address row 0.
   */
  coerce: (tsType: string) => string | null;
}

const q = (v: string) => JSON.stringify(v);

/**
 * What a path segment has to look like to be read as a number, shared by the dialects that
 * spell their own check. Optional sign, digits, optional fractional part, and nothing else: no
 * leading or trailing space, no `0x`, no exponent, no empty string.
 */
const NUMERIC_SEGMENT = String.raw`/^-?\d+(\.\d+)?$/`;

/** The digits of a bigint, the same wire spelling its column schema uses. */
const BIGINT_DIGITS = String.raw`/^-?\d+$/`;

/** The import each library's emitted expressions need, keyed the same way as `LIBS`. */
const LIB_IMPORTS: Record<Lib, string> = {
  zod: "import { z } from 'zod';",
  valibot: "import * as v from 'valibot';",
  arktype: "import { type } from 'arktype';",
};

const LIBS: Record<Lib, LibDialect> = {
  zod: {
    number: 'z.number()',
    string: 'z.string()',
    boolean: 'z.boolean()',
    date: 'z.date()',
    dateInput: 'z.iso.datetime().transform((s) => new Date(s))',
    bigint: `z.string().regex(${BIGINT_DIGITS})`,
    unknown: 'z.unknown()',
    enum: (vals) => `z.enum([${vals.map(q).join(', ')}] as const)`,
    nullable: (b) => `${b}.nullable()`,
    optional: (b) => `${b}.optional()`,
    object: (body) => `z.object({\n${body}\n})`,
    objectInline: (body) => `z.object({ ${body} })`,
    coerce: (t) =>
      t === 'number'
        ? `z.string().regex(${NUMERIC_SEGMENT}).transform(Number)`
        : t === 'Date'
          ? 'z.iso.datetime().transform((s) => new Date(s))'
          : t === 'bigint'
            ? `z.string().regex(${BIGINT_DIGITS})`
            : null,
  },
  valibot: {
    number: 'v.number()',
    string: 'v.string()',
    boolean: 'v.boolean()',
    date: 'v.date()',
    dateInput: 'v.pipe(v.string(), v.isoTimestamp(), v.transform((s) => new Date(s)))',
    bigint: `v.pipe(v.string(), v.regex(${BIGINT_DIGITS}))`,
    unknown: 'v.unknown()',
    enum: (vals) => `v.picklist([${vals.map(q).join(', ')}] as const)`,
    nullable: (b) => `v.nullable(${b})`,
    optional: (b) => `v.optional(${b})`,
    object: (body) => `v.object({\n${body}\n})`,
    objectInline: (body) => `v.object({ ${body} })`,
    // A valibot pipe step sees the previous step's *output*, so the check has to happen while
    // the value is still the string: after a `v.transform(Number)` there is no string left.
    coerce: (t) =>
      t === 'number'
        ? `v.pipe(v.string(), v.regex(${NUMERIC_SEGMENT}), v.transform(Number))`
        : t === 'Date'
          ? 'v.pipe(v.string(), v.isoTimestamp(), v.transform((s) => new Date(s)))'
          : t === 'bigint'
            ? `v.pipe(v.string(), v.regex(${BIGINT_DIGITS}))`
            : null,
  },
  arktype: {
    number: 'number',
    string: 'string',
    boolean: 'boolean',
    date: 'Date',
    dateInput: 'string.date.iso.parse',
    bigint: BIGINT_DIGITS,
    unknown: 'unknown',
    // The surrounding encode adds the quotes, so the union is built with the inner quoting
    // ArkType expects.
    enum: (vals) => vals.map((x) => `'${x.replace(/'/g, "\\'")}'`).join(' | '),
    nullable: (b) => `(${b} | null)`,
    optional: (b) => `${b}?`,
    // `.onUndeclaredKey('delete')` because ArkType's default keeps undeclared keys (measured on
    // 2.2.3), where zod and valibot strip them. A DTO's whole point is that the controller
    // receives the declared shape, so the three libraries are aligned on the strict side.
    object: (body) => `type({\n${body}\n}).onUndeclaredKey('delete')`,
    objectInline: (body) => `type({ ${body} }).onUndeclaredKey('delete')`,
    fieldIsString: true,
    // ArkType ships these as keywords, and they are morphs: the declared output type is the
    // parsed one. `string.date.iso.parse` and not `string.date.parse`, which accepts `"1"` as
    // the year 2001.
    coerce: (t) =>
      t === 'number'
        ? 'string.numeric.parse'
        : t === 'Date'
          ? 'string.date.iso.parse'
          : t === 'bigint'
            ? BIGINT_DIGITS
            : null,
  },
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);

/**
 * The columns that address one row, or `null` when nothing does.
 *
 * A table with no primary key genuinely cannot be addressed, so it gets no params DTO rather
 * than a fictional `id`. A composite key keeps all of its columns.
 */
function keyColumns(table: Table): Column[] | null {
  const names = table.primaryKey?.columns ?? [];
  if (!names.length) return null;
  const cols = names.map((n) => table.columns.find((c) => c.name === n));
  if (cols.some((c) => !c)) return null;
  return cols as Column[];
}

/** Whether the analyzer failed to give this column a type worth checking. */
function isWide(column: Column): boolean {
  if (column.enumValues && column.enumValues.length) return false;
  if (column.shape?.kind === 'tuple' || column.shape?.kind === 'numberObject') return false;
  return !['number', 'string', 'boolean', 'Date', 'bigint'].includes(column.tsType);
}

/** The schema expression for one column in one mode, before presence wrappers. */
function baseExpr(column: Column, d: LibDialect, mode: Mode): string {
  if (column.enumValues && column.enumValues.length) return d.enum(column.enumValues);
  switch (column.tsType) {
    case 'number':
      return d.number;
    case 'string':
      return d.string;
    case 'boolean':
      return d.boolean;
    case 'Date':
      return mode === 'select' ? d.date : d.dateInput;
    case 'bigint':
      return d.bigint;
    default:
      return d.unknown;
  }
}

/**
 * Presence, the part the module comment calls the inherited rule: on insert a column is
 * optional only when the database can fill it in (a default; generated columns are excluded by
 * `insertColumns` before this runs). A nullable column with no default stays required, at its
 * nullable type: null is a value, absence is not. On update everything is optional.
 */
function mapExpr(column: Column, lib: Lib, mode: Mode): string {
  const d = LIBS[lib];
  let expr = baseExpr(column, d, mode);
  if (column.nullable) expr = d.nullable(expr);
  if (mode === 'update' || (mode === 'insert' && column.hasDefault)) expr = d.optional(expr);
  return expr;
}

function objectKey(name: string): string {
  return isIdent(name) ? name : JSON.stringify(name);
}

function field(column: Column, lib: Lib, mode: Mode): string {
  const d = LIBS[lib];
  const expr = mapExpr(column, lib, mode);
  return `${objectKey(column.name)}: ${d.fieldIsString ? JSON.stringify(expr) : expr}`;
}

/**
 * One `name: <expr>` entry for a *path parameter*, which arrives as a string. A key column the
 * dialect cannot coerce keeps the string it was given rather than being validated against a
 * type no path segment can ever have.
 */
function paramField(column: Column, lib: Lib): string {
  const d = LIBS[lib];
  const expr = (() => {
    if (column.enumValues && column.enumValues.length) return d.enum(column.enumValues);
    return d.coerce(column.tsType) ?? d.string;
  })();
  return `${objectKey(column.name)}: ${d.fieldIsString ? JSON.stringify(expr) : expr}`;
}

function renderSchema(cols: Column[], lib: Lib, mode: Mode): string {
  const d = LIBS[lib];
  const body = cols.map((c) => `  ${field(c, lib, mode)},`).join('\n');
  return d.object(body);
}

/**
 * The TypeScript type of one field as the pipe hands it to the controller: the parsed side of
 * the schema. A Date column is `Date` on every mode (the input schema transforms the ISO
 * string); a bigint stays `string`, the wire form JSON can actually carry.
 */
function fieldType(column: Column): string {
  if (column.enumValues && column.enumValues.length) {
    return column.enumValues.map((x) => `'${x.replace(/'/g, "\\'")}'`).join(' | ');
  }
  switch (column.tsType) {
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'Date':
      return 'Date';
    case 'bigint':
      return 'string';
    default:
      return 'unknown';
  }
}

/** The parsed type of a path parameter, matching `LibDialect.coerce`. */
function paramFieldType(column: Column): string {
  if (column.enumValues && column.enumValues.length) return fieldType(column);
  switch (column.tsType) {
    case 'number':
      return 'number';
    case 'Date':
      return 'Date';
    default:
      return 'string';
  }
}

/** One class field line: quoted where the column name is not an identifier. */
function classField(column: Column, mode: Mode | 'params'): string {
  const key = isIdent(column.name) ? column.name : `'${column.name.replace(/'/g, "\\'")}'`;
  if (mode === 'params') return `  ${key}!: ${paramFieldType(column)};`;
  const optional = mode === 'update' || (mode === 'insert' && column.hasDefault);
  const type = `${fieldType(column)}${column.nullable ? ' | null' : ''}`;
  return optional ? `  ${key}?: ${type};` : `  ${key}!: ${type};`;
}

function toCase(s: string, c?: Case): string {
  if (!c) return s;
  const parts = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .split(/\s+/);
  if (c === 'camel') {
    return parts
      .map((p, i) =>
        i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
      )
      .join('');
  }
  if (c === 'kebab') return parts.map((p) => p.toLowerCase()).join('-');
  if (c === 'snake') return parts.map((p) => p.toLowerCase()).join('_');
  return s;
}

interface RenderContext {
  /** Absolute output directory. */
  out: string;
}

export class NestJSGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outputDir);
    const ctx: RenderContext = { out };
    await fs.mkdir(out, { recursive: true });

    const files: string[] = [];
    const write = async (filePath: string, content: string) => {
      const formatted = await formatCode(
        buildHeader(opts.outputHeader) + content,
        filePath,
        opts.format
      );
      await fs.writeFile(filePath, formatted, 'utf8');
      files.push(filePath);
    };

    const barrelPath = path.join(out, `${APP_MODULE}.ts`);
    const validationPath = path.join(out, `${VALIDATION_MODULE}.ts`);
    const modules: Array<{ filePath: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      // Both reserved names are refused up front: a table whose module would land on the barrel
      // or the pipe module must be renamed, not silently overwritten.
      if (filePath === barrelPath || filePath === validationPath) {
        const which = filePath === barrelPath ? 'the barrel' : 'the validation pipe module';
        throw new Error(
          `@drzl/generator-nestjs: the DTOs for table "${table.name}" would be written to ` +
            `${filePath}, which is ${which} this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
        );
      }
      await write(filePath, renderTable(table, opts));
      modules.push({ filePath });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    // The pipe is a deliverable, not an internal helper: consumers import it from the barrel to
    // bind it, so it is emitted even when the schema has no tables yet and the import stays
    // stable while the schema grows.
    await write(validationPath, renderValidationModule());
    await write(barrelPath, renderBarrel(modules, ctx, path, opts));
    return { files };
  }
}

export default NestJSGenerator;

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

/**
 * The pipe module: `SchemaValidationPipe` over Standard Schema v1, emitted rather than
 * installed, the same decision as the Express generator's middleware and for the same reason:
 * a ~40 line pipe adds zero dependencies beyond `@nestjs/common`, which a Nest app has by
 * definition, and covers every library the DTOs can be generated with.
 */
function renderValidationModule(): string {
  return `// Generated by @drzl/generator-nestjs
// A validation pipe over Standard Schema v1. Bind it globally
// (app.useGlobalPipes(new SchemaValidationPipe())) or per handler with @UsePipes. A parameter
// whose class carries a static Standard Schema (every DTO in this directory) is validated and
// replaced by the parsed output; anything else, primitives and foreign DTOs alike, passes
// through untouched. On failure it throws BadRequestException with
// { error, slot, issues: [{ message, path }] }, which Nest answers as a 400.
//
// These DTOs do not use Nest's class-validator ValidationPipe and assume nothing about its
// options. If your app also binds one globally, note one measured interaction: with
// whitelist: true it strips every property of these classes before this pipe runs, because
// they carry no class-validator metadata.
import { BadRequestException, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';

interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

export interface StandardSchema<Output = unknown> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) => StandardResult<Output> | Promise<StandardResult<Output>>;
  };
}

interface CarriesSchema {
  readonly schema: StandardSchema;
}

function carriesSchema(metatype: unknown): metatype is CarriesSchema {
  return (
    typeof metatype === 'function' &&
    typeof (metatype as { schema?: { '~standard'?: { validate?: unknown } } }).schema?.[
      '~standard'
    ]?.validate === 'function'
  );
}

export class SchemaValidationPipe implements PipeTransform {
  async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    const { metatype } = metadata;
    if (!carriesSchema(metatype)) return value;
    const result = await metatype.schema['~standard'].validate(value);
    if (result.issues) {
      throw new BadRequestException({
        error: 'Validation failed',
        slot: metadata.type,
        issues: result.issues.map((issue) => ({
          message: issue.message,
          path: (issue.path ?? []).map((p) => (typeof p === 'object' && p !== null ? p.key : p)),
        })),
      });
    }
    return result.value;
  }
}
`;
}

function renderTable(table: Table, opts: GenerateOptions): string {
  const lib: Lib = (opts.validation?.library ?? 'zod') as Lib;
  const d = LIBS[lib];

  const insertName = `Insert${table.tsName}Schema`;
  const updateName = `Update${table.tsName}Schema`;
  const selectName = `Select${table.tsName}Schema`;
  // A params schema is this generator's own invention, because only the emitting side knows
  // that these particular columns arrive as path segments.
  const paramsName = `${cap(table.tsName)}ParamsSchema`;

  const createDto = `Create${cap(table.tsName)}Dto`;
  const updateDto = `Update${cap(table.tsName)}Dto`;
  const paramsDto = `${cap(table.tsName)}ParamsDto`;
  const entity = `${cap(table.tsName)}Entity`;

  // A materialized view refuses every write, so an insert or update DTO on one describes an
  // operation the database always rejects.
  const writable = !table.readOnly;
  const key = keyColumns(table);

  const declared: string[] = [];

  const insertCols = insertColumns(table);
  const updateCols = updateColumns(table);
  const selectCols = selectColumns(table);

  if (writable) {
    declared.push(`export const ${insertName} = ${renderSchema(insertCols, lib, 'insert')};`);
    declared.push(`export const ${updateName} = ${renderSchema(updateCols, lib, 'update')};`);
  }
  declared.push(`export const ${selectName} = ${renderSchema(selectCols, lib, 'select')};`);
  if (key) {
    declared.push(
      `export const ${paramsName} = ${d.objectInline(key.map((c) => paramField(c, lib)).join(', '))};`
    );
  }

  const dtoClass = (
    name: string,
    doc: string,
    cols: Column[],
    mode: Mode | 'params',
    schema: string
  ) => {
    const fields = cols.map((c) => classField(c, mode)).join('\n');
    return `/**\n * ${doc}\n */\nexport class ${name} {\n${fields}\n\n  static readonly schema: StandardSchema<${name}> = ${schema};\n}`;
  };

  if (writable) {
    declared.push(
      dtoClass(
        createDto,
        `The insert shape of ${table.name}. Fields state what the pipe hands your controller; ` +
          `a nullable column with no default is required, null spelled out.`,
        insertCols,
        'insert',
        insertName
      )
    );
    declared.push(
      dtoClass(
        updateDto,
        `The update shape of ${table.name}: every field optional, primary key excluded.`,
        updateCols,
        'update',
        updateName
      )
    );
  }
  if (key) {
    declared.push(
      dtoClass(
        paramsDto,
        `The path parameters addressing one ${table.name} row, parsed strictly from their ` +
          `string segments.`,
        key,
        'params',
        paramsName
      )
    );
  }
  declared.push(
    dtoClass(
      entity,
      `One ${table.name} row, at its select shape.`,
      selectCols,
      'select',
      selectName
    )
  );

  const decided = declared.join('\n\n');

  const imports: string[] = [];
  imports.push(LIB_IMPORTS[lib]);
  const spec = importSpecifier(`./${VALIDATION_MODULE}.ts`, opts.importExtension);
  imports.push(`import type { StandardSchema } from '${spec}';`);

  const wide = table.columns.filter(isWide).map((c) => c.name);
  const wideNote = wide.length
    ? `// No validated type for ${wide.length === 1 ? 'this column' : 'these columns'}: ${wide.join(', ')}.\n` +
      `// DRZL could not derive one from the schema, so these DTOs accept any value there.\n`
    : '';

  return `// Generated by @drzl/generator-nestjs
// DTOs for table: ${table.name}
${wideNote}${imports.join('\n')}

${decided}
`;
}

/**
 * The barrel: every table module and the pipe module re-exported, so a consumer imports DTO
 * classes and the pipe from one place. There is no module, no controller and no provider to
 * assemble: those belong to the consumer's app.
 */
function renderBarrel(
  modules: Array<{ filePath: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions
): string {
  const validationSpec = importSpecifier(`./${VALIDATION_MODULE}.ts`, opts.importExtension);
  if (!modules.length) {
    return `// Generated by @drzl/generator-nestjs
// No tables detected in analysis. Add tables to your schema and regenerate.
export * from '${validationSpec}';
`;
  }

  const reExports = modules
    .map(({ filePath }) => {
      const rel = importSpecifier(
        './' + path.relative(ctx.out, filePath).replace(/\\/g, '/'),
        opts.importExtension
      );
      return `export * from '${rel}';`;
    })
    .join('\n');

  return `// Generated by @drzl/generator-nestjs
${reExports}
export * from '${validationSpec}';
`;
}
