import {
  BIGINT_DIGITS_PATTERN as BIGINT_DIGITS,
  VALIBOT_JSON_CONST,
  VALIBOT_JSON_SOURCE,
  fileWriter,
  type FileSink,
} from '@drzl/validation-core';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import type { AffixOptions, ImportExtension } from '@drzl/validation-core';
import {
  formatCode,
  importSpecifier,
  resolveAffix,
  resolveConfiguredImport,
  schemaName,
} from '@drzl/validation-core';

/**
 * Hono routes, in Hono's own idiom.
 *
 * Why this is a generator and not a template. A DRZL "template" is `ORPCTemplateHooks`, and both
 * shipped ones (`@drzl/template-standard`, `@drzl/template-orpc-service`) hand back oRPC source
 * text: `os.handler(...)`, `os.input(...)`, `ORPCError`. None of that is Hono, so a Hono template
 * written against that interface would emit a file that does not compile. The tRPC generator
 * reached the same conclusion and shipped without a hook API rather than borrowing one.
 *
 * Why this is not an adapter for the routers DRZL already emits. Hono hosts both of them today and
 * neither needs anything from this repository: `@hono/trpc-server` mounts a tRPC router as
 * middleware, and oRPC's `RPCHandler` from `@orpc/server/fetch` mounts on any fetch handler. Those
 * are four-line integrations documented by Hono and by oRPC. What nothing emits is Hono's *own*
 * surface, the thing people choose Hono for: real HTTP routes carrying a validator, with
 * `hc<AppType>()` inferring the client from the route types. That is the gap this closes.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported routes identifier. */
  routerSuffix?: string;
  /** Casing applied to file names, identifiers and the mounted URL segment. */
  procedureCase?: Case;
}

/**
 * Which of Hono's two official validator middlewares the routes carry.
 *
 * Established from the registry rather than from memory, on 2026-08-08:
 *
 *   @hono/standard-validator  0.4.0   peers: @standard-schema/spec ^1.0.0, hono >=4.11.2
 *   @hono/zod-validator       0.9.0   peers: zod ^3.25.0 || ^4.0.0, hono >=4.11.2
 *
 * So the zod one did not become Standard-Schema-based; both exist, and they are different
 * packages with different peer sets.
 *
 * `standard` is the default because DRZL emits zod, valibot and arktype schemas and all three
 * implement Standard Schema v1, so one middleware covers every library this generator can be
 * pointed at. `zod` is offered because it is by far the more installed of the two and a project
 * already carrying it should not have to add a second package to use these routes.
 */
export type ValidatorMiddleware = 'standard' | 'zod';

/** The barrel's filename stem, and the identifier it exports the assembled app as. */
export const APP_MODULE = 'index';

export interface GenerateOptions {
  outputDir: string;
  includeRelations?: boolean;
  naming?: NamingOptions;
  /** Which middleware validates, and therefore which package the routes import. */
  validator?: ValidatorMiddleware;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /**
   * How every relative specifier this generator invents spells its extension: the barrel's import
   * of each route module, and `validation.importPath`. Defaults to `'js'`, the only form that
   * resolves under every `moduleResolution` without a compiler flag.
   */
  importExtension?: ImportExtension;
  validation?: {
    useShared?: boolean;
    library?: 'zod' | 'valibot' | 'arktype';
    importPath?: string;
    schemaSuffix?: string;
    affix?: AffixOptions;
  };
  /**
   * Where the generated files go, when that is not the filesystem.
   *
   * Omitted, they go to disk exactly as before. Passed, every write and every `mkdir` is handed
   * to the sink instead, which is what `drzl generate --dry-run` and `drzl generate --check`
   * are built on: both need the content a run would produce without the run producing it. See
   * `emit.ts` in @drzl/validation-core for why this is an option rather than an interception of
   * `node:fs/promises`.
   */
  fileSink?: FileSink;
}

type Lib = NonNullable<NonNullable<GenerateOptions['validation']>['library']>;

interface LibDialect {
  number: string;
  string: string;
  boolean: string;
  date: string;
  /**
   * A Date crossing JSON, which is a different thing from a Date.
   *
   * A JSON body cannot carry a `Date`: `JSON.stringify(new Date())` is a string, and `c.req.json()`
   * hands the validator a string. So `date` above, which is the read side where the value is a row
   * the driver already mapped, is unusable on the write side, and a request carrying a date column
   * could not be written at all. Measured through the emitted app before the fix: every JSON
   * spelling of a date was rejected, so no valid POST existed.
   *
   * The strict ISO spelling, transformed into the `Date` the handler expects, matching the NestJS
   * and Express generators. Strict because `new Date('1')` is the year 2001, so a lenient parse
   * turns a typo into a row.
   */
  dateInput: string;
  unknown: string;
  /**
   * A json column, which a request body carries natively.
   *
   * These three used to fall to `unknown`, which is the widest thing a schema can say and was not
   * true of any of them: the same column is typed by every standalone validator generator, so DRZL
   * gave one column three answers depending on which generator wrote it. What each needs is its
   * *wire* form, which is the same rule the Date entry above follows.
   *
   * A body has been through `JSON.parse`, so a json column's value is a json value by
   * construction. Stating that gives the handler a typed value rather than `unknown`.
   */
  json: string;
  /**
   * A bigint crossing JSON, which it cannot do as a number: `JSON.stringify(1n)` throws on the way
   * out and a `number` loses precision past 2^53. So it travels as its decimal digits and stays a
   * string on both sides, which is what the NestJS generator settled on and pins with a test.
   */
  bigintWire: string;
  /**
   * A binary column on the way in. `JSON.stringify(new Uint8Array([1,2]))` is `{"0":1,"1":2}`, not
   * bytes, so the wire form is base64 and the write side decodes it to the `Uint8Array` the driver
   * wants. The read side stays a real `Uint8Array`, which is what the handler returns, exactly as
   * the Date entry keeps a real Date there.
   */
  binaryWire: string;
  /** A binary column on the read side, which is a real Uint8Array. */
  binaryRead: string;
  enum: (values: string[]) => string;
  nullable: (base: string) => string;
  optional: (base: string) => string;
  object: (body: string) => string;
  objectInline: (body: string) => string;
  partialUpdate?: (schema: string) => string;
  /** ArkType spells a field's type as a string literal; the others spell it as an expression. */
  fieldIsString?: boolean;
  /**
   * A path segment parsed into `tsType`.
   *
   * This has no counterpart in the tRPC generator and is the largest behavioural difference
   * between the two. tRPC transports JSON, so a `number` primary key arrives as a number and
   * `z.number()` accepts it. A URL path segment is always a string: `GET /users/1` delivers
   * `"1"`, and `z.number()` rejects it, so a route validated with the select-mode expression
   * rejects every request it was written to serve.
   *
   * All three spellings here are the *strict* ones, and that is a decision taken from a
   * measurement rather than from taste. The idiomatic coercions are built on `Number()`, and
   * `Number('')` is `0`. Measured on zod 4.4.3, valibot 1.1.0 and arktype 2.1.29:
   *
   *   input        z.coerce.number()   v.transform(Number)   strict regex   string.numeric.parse
   *   ""           0                   0                     rejected       rejected
   *   " "          0                   0                     rejected       rejected
   *   " 1 "        1                   1                     rejected       rejected
   *   "0x10"       16                  16                    rejected       rejected
   *   "1e5"        100000              100000                rejected       rejected
   *   "Infinity"   rejected            Infinity              rejected       rejected
   *   "abc"        rejected            rejected              rejected       rejected
   *
   * `GET /users/%20` addressing row `0` is not a coercion working loosely, it is the wrong row.
   * The strict column is also the only one where the three libraries agree, so a project that
   * switches `validation.library` keeps the same routes. The one residue is `"00"`, which the
   * regex accepts as `0` and ArkType rejects.
   *
   * Every row of that table was executed before it was written down. An earlier draft of this
   * comment asserted that the naive valibot pipe accepts `NaN`, reasoning that a pipe step sees
   * the previous step's output so `v.number()` would be handed `Number('abc')`. The pipe part is
   * true and the conclusion is false: valibot's `number()` rejects `NaN`, so that spelling is safe
   * and merely too permissive elsewhere. It was disproved by running it.
   */
  coerce: (tsType: string) => string | null;
  /** The type of one parsed row, from the select schema. */
  infer: (schema: string) => string;
}

const q = (v: string) => JSON.stringify(v);

/**
 * A string literal in the emitted source, single-quoted where it can be.
 *
 * `JSON.stringify` is the safe spelling and it is the wrong one to reach for by default here: a
 * formatter is an *optional* peer, so a project without prettier reads exactly these bytes, and
 * `JSON.stringify` produces `.route("/users", …)` two lines below `import { Hono } from 'hono';`.
 * Prettier normalises that away, which is precisely why it went unnoticed until the parity fixture
 * turned formatting off. Anything carrying a quote or a backslash falls back to `JSON.stringify`,
 * which is correct for every input.
 */
const lit = (v: string) => (/['\\]/.test(v) ? JSON.stringify(v) : `'${v}'`);

/**
 * What a path segment has to look like to be read as a number, shared by the two dialects that
 * spell their own check. Optional sign, digits, optional fractional part, and nothing else: no
 * leading or trailing space, no `0x`, no exponent, no empty string.
 */
const NUMERIC_SEGMENT = String.raw`/^-?\d+(\.\d+)?$/`;

/** The import each library's emitted expressions need, keyed the same way as `LIBS`. */
const LIB_IMPORTS: Record<Lib, string> = {
  zod: "import { z } from 'zod';",
  valibot: "import * as v from 'valibot';",
  arktype: "import { type } from 'arktype';",
};

/**
 * Whether a finished file body actually mentions a library, so its import is emitted only where it
 * is used. Same rule and same reasoning as the tRPC generator: `noUnusedLocals` fails on an unused
 * import, `verbatimModuleSyntax` keeps it, and a module importing a package the consumer did not
 * install throws on load rather than when the unused thing is touched.
 */
const LIB_USAGE: Record<Lib, RegExp> = {
  zod: /\bz\./,
  valibot: /\bv\./,
  arktype: /\btype\(|\.infer\b/,
};

const LIBS: Record<Lib, LibDialect> = {
  zod: {
    number: 'z.number()',
    string: 'z.string()',
    boolean: 'z.boolean()',
    date: 'z.date()',
    dateInput: 'z.iso.datetime().transform((s) => new Date(s))',
    unknown: 'z.unknown()',
    json: 'z.json()',
    bigintWire: `z.string().regex(${BIGINT_DIGITS})`,
    binaryWire: 'z.base64().transform((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))',
    binaryRead: 'z.instanceof(Uint8Array)',
    enum: (vals) => `z.enum([${vals.map(q).join(', ')}] as const)`,
    nullable: (b) => `${b}.nullable()`,
    optional: (b) => `${b}.optional()`,
    object: (body) => `z.object({\n${body}\n})`,
    objectInline: (body) => `z.object({ ${body} })`,
    partialUpdate: (s) => `${s}.partial()`,
    // Not `z.coerce.number()`, and not `z.coerce.date()`: both accept far more than a path
    // segment addressing a row should. See the measured grid on `LibDialect.coerce`.
    coerce: (t) =>
      t === 'number'
        ? `z.string().regex(${NUMERIC_SEGMENT}).transform(Number)`
        : t === 'Date'
          ? 'z.iso.datetime().transform((s) => new Date(s))'
          : null,
    infer: (s) => `z.output<typeof ${s}>`,
  },
  valibot: {
    number: 'v.number()',
    string: 'v.string()',
    boolean: 'v.boolean()',
    date: 'v.date()',
    dateInput: 'v.pipe(v.string(), v.isoTimestamp(), v.transform((s) => new Date(s)))',
    unknown: 'v.unknown()',
    json: VALIBOT_JSON_CONST,
    bigintWire: `v.pipe(v.string(), v.regex(${BIGINT_DIGITS}))`,
    binaryWire:
      'v.pipe(v.string(), v.base64(), v.transform((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))))',
    binaryRead: 'v.instance(Uint8Array)',
    enum: (vals) => `v.picklist([${vals.map(q).join(', ')}] as const)`,
    nullable: (b) => `v.nullable(${b})`,
    optional: (b) => `v.optional(${b})`,
    object: (body) => `v.object({\n${body}\n})`,
    objectInline: (body) => `v.object({ ${body} })`,
    // A valibot pipe step sees the previous step's *output*, so the check has to happen while the
    // value is still the string: by the time a `v.transform(Number)` has run there is no string
    // left to look at. See the measured grid on `LibDialect.coerce`.
    coerce: (t) =>
      t === 'number'
        ? `v.pipe(v.string(), v.regex(${NUMERIC_SEGMENT}), v.transform(Number))`
        : t === 'Date'
          ? 'v.pipe(v.string(), v.isoTimestamp(), v.transform((s) => new Date(s)))'
          : null,
    infer: (s) => `v.InferOutput<typeof ${s}>`,
  },
  arktype: {
    number: 'number',
    string: 'string',
    boolean: 'boolean',
    date: 'Date',
    dateInput: 'string.date.iso.parse',
    unknown: 'unknown',
    json: 'number | object | string | boolean | null',
    bigintWire: BIGINT_DIGITS,
    binaryWire: 'string.base64',
    binaryRead: 'TypedArray.Uint8',
    // The surrounding encode adds the quotes, so the union is built with the inner quoting
    // ArkType expects.
    enum: (vals) => vals.map((x) => `'${x.replace(/'/g, "\\'")}'`).join(' | '),
    nullable: (b) => `(${b} | null)`,
    optional: (b) => `${b}?`,
    object: (body) => `type({\n${body}\n})`,
    objectInline: (body) => `type({ ${body} })`,
    fieldIsString: true,
    // ArkType ships these as keywords, and they are *morphs*: the declared output type is
    // `number`, not `string`. Returned bare, because `fieldIsString` quotes every expression this
    // dialect produces and a keyword returned pre-quoted arrives as `"'string.numeric.parse'"`,
    // which ArkType reads as a string *literal* type matching nothing but that sentence.
    //
    // `string.date.parse` and not `string.date.iso.parse` was the first draft, and it accepts
    // `"1"` as the year 2001, which is the same over-permissiveness the coercing spellings have.
    coerce: (t) =>
      t === 'number' ? 'string.numeric.parse' : t === 'Date' ? 'string.date.iso.parse' : null,
    infer: (s) => `typeof ${s}.infer`,
  },
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);

/**
 * The columns that address one row, or `null` when nothing does.
 *
 * Taken from the tRPC generator unchanged, including the reason. A table with no primary key
 * genuinely cannot be addressed, and the oRPC generator's answer is to emit
 * `z.object({ id: z.number() })` regardless, naming a column that may not exist and typing it as a
 * number when it may be a uuid. Here the key is read off `primaryKey`, every column of it, at its
 * real type, and a table without one loses the routes that would have needed it rather than
 * gaining a fictional `id`.
 *
 * A composite key keeps all of its columns, so the path becomes `/:orgId/:userId`.
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
  // A json or binary column is not wide any more: each states its wire form. What is left here is
  // a column the analyzer could not type at all, which is a `customType` without `$type<T>()`.
  if (column.shape?.kind === 'json' || column.shape?.kind === 'buffer') return false;
  if (column.tsType === 'Uint8Array') return false;
  return !['number', 'string', 'boolean', 'Date', 'bigint'].includes(column.tsType);
}

function mapExpr(column: Column, lib: Lib, mode: 'insert' | 'update' | 'select'): string {
  const d = LIBS[lib];
  let base = (() => {
    if (column.enumValues && column.enumValues.length) return d.enum(column.enumValues);
    switch (column.tsType) {
      case 'number':
        return d.number;
      case 'string':
        return d.string;
      case 'boolean':
        return d.boolean;
      case 'Date':
        // The read side is a real Date the driver produced; the write side is a JSON string.
        return mode === 'select' ? d.date : d.dateInput;
      case 'bigint':
        return d.bigintWire;
      default:
        // Shape before type: the analyzer states `json` and `buffer` as shapes, and the tsType
        // beside them is `any` or `Uint8Array`, neither of which says what crosses the wire.
        if (column.shape?.kind === 'json') return d.json;
        if (column.shape?.kind === 'buffer' || column.tsType === 'Uint8Array') {
          return mode === 'select' ? d.binaryRead : d.binaryWire;
        }
        return d.unknown;
    }
  })();
  if (column.nullable) base = d.nullable(base);
  if (mode !== 'select') {
    const optional = mode === 'update' || column.nullable || column.hasDefault;
    if (optional) base = d.optional(base);
  }
  return base;
}

function objectKey(name: string): string {
  return isIdent(name) ? name : JSON.stringify(name);
}

function field(column: Column, lib: Lib, mode: 'insert' | 'update' | 'select'): string {
  const d = LIBS[lib];
  const expr = mapExpr(column, lib, mode);
  return `${objectKey(column.name)}: ${d.fieldIsString ? JSON.stringify(expr) : expr}`;
}

/**
 * One `name: <expr>` entry for a *path parameter*, which arrives as a string.
 *
 * A key column the dialect cannot coerce keeps the string it was given rather than being validated
 * against a type no path segment can ever have. `enum` is already a set of strings and needs no
 * coercion.
 */
function paramField(column: Column, lib: Lib): string {
  const d = LIBS[lib];
  const expr = (() => {
    if (column.enumValues && column.enumValues.length) return d.enum(column.enumValues);
    return d.coerce(column.tsType) ?? d.string;
  })();
  return `${objectKey(column.name)}: ${d.fieldIsString ? JSON.stringify(expr) : expr}`;
}

function renderSchema(table: Table, lib: Lib, mode: 'insert' | 'update' | 'select'): string {
  const d = LIBS[lib];
  const cols = table.columns.filter((c) => (mode === 'select' ? true : !c.isGenerated));
  const body = cols.map((c) => `  ${field(c, lib, mode)},`).join('\n');
  const schema = d.object(body);
  return mode === 'update' && d.partialUpdate ? d.partialUpdate(schema) : schema;
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

/** The exported identifier: `usersRoutes`, and `kebab` falls back to camel since `-` is invalid. */
function routesExportName(table: Table, naming?: NamingOptions): string {
  const base = `${table.tsName}${naming?.routerSuffix ?? 'Routes'}`;
  const c = naming?.procedureCase;
  return toCase(base, c === 'kebab' ? 'camel' : c);
}

/**
 * The URL segment this table's routes are mounted under: `/users`.
 *
 * `tsName` and not `name`, for the same reason the tRPC barrel keys on `tsName`: it is the
 * identifier the user wrote in their schema, and the oRPC barrel's lowercasing turns
 * `userProfiles` into `userprofiles`, which is not harmless when it is the public surface a typed
 * client is built from. `naming.procedureCase: 'kebab'` is how you ask for `/user-profiles`, and
 * unlike the export name a URL segment can actually carry a hyphen.
 */
function mountPath(table: Table, naming?: NamingOptions): string {
  return `/${toCase(table.tsName, naming?.procedureCase)}`;
}

interface Route {
  /** For ordering only. */
  name: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  /** Middleware expressions, in the order Hono runs them. */
  middleware: string[];
  body: string[];
}

interface RenderContext {
  /** Absolute output directory. */
  out: string;
}

export class HonoGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions) {
    const fs = fileWriter(opts.fileSink);
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
    const modules: Array<{ table: Table; filePath: string; exportName: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      if (filePath === barrelPath) {
        throw new Error(
          `@drzl/generator-hono: the routes for table "${table.name}" would be written to ` +
            `${filePath}, which is the barrel this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
        );
      }
      await write(filePath, renderRoutes(table, opts, ctx));
      modules.push({ table, filePath, exportName: routesExportName(table, opts.naming) });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    await write(barrelPath, renderBarrel(modules, ctx, path, opts));
    return { files };
  }
}

export default HonoGenerator;

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

/** The middleware's imported name and the package it comes from. */
const VALIDATORS: Record<ValidatorMiddleware, { fn: string; from: string }> = {
  standard: { fn: 'sValidator', from: '@hono/standard-validator' },
  zod: { fn: 'zValidator', from: '@hono/zod-validator' },
};

/**
 * Where a stub finds the data the middleware just validated.
 *
 * A comment and not `const params = c.req.valid('param');`, which is what this was first, because
 * a stub does not read it and `noUnusedLocals` reports an unused local as an error. The underscore
 * convention does not rescue it either: measured on TypeScript 5.9, `noUnusedParameters` exempts a
 * parameter named `_params` and `noUnusedLocals` does not exempt a *local* of the same name, so
 * the tRPC generator's `{ input: _input }` has no counterpart here. Hono hands the validated value
 * back through a method call rather than through the handler's parameter list, which is the whole
 * difference.
 */
const VALID_PARAM_HINT = "// The validated path parameters are at c.req.valid('param').";

function renderRoutes(table: Table, opts: GenerateOptions, ctx: RenderContext): string {
  const lib: Lib = (opts.validation?.library ?? 'zod') as Lib;
  const d = LIBS[lib];
  const validator = VALIDATORS[opts.validator ?? 'standard'];

  const insertName = `Insert${table.tsName}Schema`;
  const updateName = `Update${table.tsName}Schema`;
  const selectName = `Select${table.tsName}Schema`;
  // Not shared with the validation generators: a params schema is this generator's own invention,
  // because only a router knows that these particular columns arrive as path segments.
  const paramsName = `${cap(table.tsName)}ParamsSchema`;
  const rowType = `Select${table.tsName}Row`;

  // A materialized view refuses every write, so a create, update or delete route on one describes
  // an operation the database always rejects, and its insert and update schemas describe rows that
  // can never be written. The validation generators already omit those schemas for a read-only
  // table, so importing them here would import nothing.
  const writable = !table.readOnly;
  const key = keyColumns(table);

  const routes: Route[] = [];
  const notImplemented = (what: string) =>
    `throw new Error('Not implemented: ${what} ${table.tsName}.');`;

  // list -----------------------------------------------------------------------------------------
  routes.push({
    name: 'list',
    method: 'get',
    path: '/',
    middleware: [],
    // The stub states its own contract. tRPC has `.output()` and Hono has nothing like it: what a
    // Hono client infers is the *handler's return type*, so the only place an output schema can be
    // honoured is the value handed to `c.json`. Annotating the local is what puts the select shape
    // into `hc<AppType>()` rather than `never[]`.
    body: [`const rows: ${rowType}[] = [];`, 'return c.json(rows);'],
  });

  if (key) {
    const keyPath = '/' + key.map((c) => `:${c.name}`).join('/');

    // byId ---------------------------------------------------------------------------------------
    routes.push({
      name: 'byId',
      method: 'get',
      path: keyPath,
      middleware: [`${validator.fn}('param', ${paramsName})`],
      body: [VALID_PARAM_HINT, `const row: ${rowType} | null = null;`, 'return c.json(row);'],
    });

    if (writable) {
      // update -----------------------------------------------------------------------------------
      routes.push({
        name: 'update',
        method: 'patch',
        path: keyPath,
        middleware: [
          `${validator.fn}('param', ${paramsName})`,
          `${validator.fn}('json', ${updateName})`,
        ],
        body: [notImplemented('update')],
      });

      // delete -----------------------------------------------------------------------------------
      routes.push({
        name: 'delete',
        method: 'delete',
        path: keyPath,
        middleware: [`${validator.fn}('param', ${paramsName})`],
        body: [VALID_PARAM_HINT, 'return c.json(true);'],
      });
    }
  }

  if (writable) {
    // create -------------------------------------------------------------------------------------
    // Emitted with or without a primary key: inserting a row does not require being able to
    // address one afterwards.
    //
    // The stub throws rather than returning the validated input. The input is the *insert* shape,
    // where generated and defaulted columns are optional, and the response is declared as the
    // *select* shape, where they are required, so returning the input is a compile error and not a
    // loose placeholder. A body that only throws has type `never`, which honours any contract and
    // says plainly that the work is not done.
    routes.push({
      name: 'create',
      method: 'post',
      path: '/',
      middleware: [`${validator.fn}('json', ${insertName})`],
      body: [notImplemented('create')],
    });
  }

  // relation lookups -------------------------------------------------------------------------
  if (opts.includeRelations) {
    routes.push(...relationRoutes(table, lib, rowType, validator.fn, opts));
  }

  // Ordered so a reader finds CRUD where they expect it, independent of the order the branches
  // above happened to push them in. This is presentation only: `/` and `/:id` do not compete for a
  // match in Hono's router, so no ordering here changes which handler serves a request.
  const order = ['list', 'byId', 'create', 'update', 'delete'];
  const rank = (n: string) => (order.indexOf(n) === -1 ? order.length : order.indexOf(n));
  routes.sort((a, b) => rank(a.name) - rank(b.name));

  const exportName = routesExportName(table, opts.naming);

  // Chained, and this is not a style choice. `hc<AppType>()` infers the client from the accumulated
  // route type, and that type only accumulates through the return value of each `.get`/`.post`.
  // Writing `const app = new Hono(); app.get(...)` compiles and runs identically and infers an app
  // with no routes on it at all, which is the failure this generator exists to avoid.
  const chain = routes
    .map((r) => {
      const args = [lit(r.path), ...r.middleware].join(', ');
      // The context parameter is named for whether the body reads it. A stub whose only statement
      // is `throw` never touches `c`, and `noUnusedParameters` reports an unused parameter as an
      // error; unlike a local, a parameter *is* exempted by a leading underscore.
      const ctxParam = r.body.some((line) => /\bc\./.test(line)) ? 'c' : '_c';
      return [
        `  .${r.method}(${args}, async (${ctxParam}) => {`,
        ...r.body.map((line) => `    ${line}`),
        `  })`,
      ].join('\n');
    })
    .join('\n');

  const body = `export const ${exportName} = new Hono()\n${chain};\n`;

  const useShared = !!opts.validation?.useShared && !!opts.validation?.importPath;
  const declared: string[] = [];
  if (!useShared) {
    if (writable) {
      declared.push(`export const ${insertName} = ${renderSchema(table, lib, 'insert')};`);
      declared.push(`export const ${updateName} = ${renderSchema(table, lib, 'update')};`);
    }
    declared.push(`export const ${selectName} = ${renderSchema(table, lib, 'select')};`);
  }

  // The params schema is always declared, never imported: no validation generator emits one.
  if (key) {
    declared.push(
      `export const ${paramsName} = ${d.objectInline(
        key.map((c) => paramField(c, lib)).join(', ')
      )};`
    );
  }

  declared.push(`export type ${rowType} = ${d.infer(selectName)};`);

  const decided = [...declared, body].join('\n\n');

  const imports: string[] = [];
  if (useShared) {
    // Only the schemas this file actually mentions. A read-only table never references the insert
    // or update schema, and the validation generators do not emit those for one, so importing them
    // would be an import that resolves to nothing.
    const sharedAffix = resolveAffix({
      affix: opts.validation?.affix,
      schemaSuffix: opts.validation?.schemaSuffix,
    });
    const wanted: Array<['insert' | 'update' | 'select', string]> = (
      [
        ['insert', insertName],
        ['update', updateName],
        ['select', selectName],
      ] as Array<['insert' | 'update' | 'select', string]>
    ).filter(([, local]) => decided.includes(local));
    if (wanted.length) {
      // `importPath` is resolved against the directory the routes are written to. Emitting it
      // verbatim turns a project-relative value such as `src/validators/zod` into a *bare*
      // specifier naming a package that does not exist, and the import resolves to nothing.
      const spec = resolveConfiguredImport(
        opts.validation!.importPath!,
        ctx.out,
        process.cwd(),
        opts.importExtension
      );
      const names = wanted
        .map(([mode, local]) => {
          const exported = schemaName(mode, table.tsName, sharedAffix);
          return exported === local ? local : `${exported} as ${local}`;
        })
        .join(', ');
      imports.push(`import { ${names} } from '${spec}';`);
    }
  }

  imports.push(`import { Hono } from 'hono';`);

  // Decided against the finished text. A read-only, keyless table under shared validation carries
  // no validator middleware at all, because its only route takes no input, and importing
  // `sValidator` there would import a package the consumer need not have installed.
  if (decided.includes(`${validator.fn}(`)) {
    imports.push(`import { ${validator.fn} } from '${validator.from}';`);
  }
  if (LIB_USAGE[lib].test(decided)) imports.unshift(LIB_IMPORTS[lib]);

  const wide = table.columns.filter(isWide).map((c) => c.name);
  const wideNote = wide.length
    ? `// No validated type for ${wide.length === 1 ? 'this column' : 'these columns'}: ${wide.join(', ')}.\n` +
      `// DRZL could not derive one from the schema, so these routes accept any value there.\n`
    : '';

  // The valibot json value space, emitted once into any module that references it. Decided against
  // the finished text rather than from the column list, which is the same rule the imports above
  // follow: a module that mentions the name defines it, and one that does not stays as it was.
  const jsonPreamble = decided.includes(VALIBOT_JSON_CONST) ? `\n${VALIBOT_JSON_SOURCE}` : '';

  return `// Generated by @drzl/generator-hono
// Routes for table: ${table.name}
${wideNote}${imports.join('\n')}
${jsonPreamble}
${decided}`;
}

/**
 * One lookup route per single-column foreign key: `GET /posts/by-author-id/:authorId`.
 *
 * Named after the column, not the referenced table, because two keys frequently point at the same
 * table (`authorId` and `editorId` both referencing `users`) and naming by table would emit one
 * path twice.
 *
 * Restricted to single-column keys returning rows of *this* table, whose row type is already in
 * scope. The inverse direction needs another module's schema and that import is circular whenever
 * both directions exist, so it is absent rather than half-working.
 *
 * The segment is a literal prefix rather than a bare `/:authorId`, which would be
 * indistinguishable from the primary-key route and would shadow it whenever the two were declared
 * in that order.
 */
function relationRoutes(
  table: Table,
  lib: Lib,
  rowType: string,
  validatorFn: string,
  opts: GenerateOptions
): Route[] {
  const d = LIBS[lib];
  const out: Route[] = [];
  const taken = new Set<string>();
  for (const fk of table.foreignKeys ?? []) {
    if (fk.columns.length !== 1) continue;
    const colName = fk.columns[0];
    const column = table.columns.find((c) => c.name === colName);
    if (!column) continue;
    const segment = toCase(`by-${colName}`, opts.naming?.procedureCase ?? 'kebab');
    if (taken.has(segment)) continue;
    taken.add(segment);

    const inline = d.objectInline(paramField(column, lib));
    out.push({
      name: `listBy${cap(colName)}`,
      method: 'get',
      path: `/${segment}/:${colName}`,
      middleware: [`${validatorFn}('param', ${inline})`],
      body: [VALID_PARAM_HINT, `const rows: ${rowType}[] = [];`, 'return c.json(rows);'],
    });
  }
  return out;
}

/**
 * The barrel: one Hono app with every table's routes mounted, and the type a client is built from.
 *
 * `.route()` is chained for the same reason the per-table routes are: the accumulated type is the
 * return value, and a loop calling `app.route(...)` and discarding the result produces an `AppType`
 * with nothing on it.
 */
function renderBarrel(
  modules: Array<{ table: Table; filePath: string; exportName: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions
): string {
  if (!modules.length) {
    return `// Generated by @drzl/generator-hono
// No tables detected in analysis. Add tables to your schema and regenerate.
import { Hono } from 'hono';

export const app = new Hono();

/** The type a Hono client is parameterised by: \`hc<AppType>('/')\`. */
export type AppType = typeof app;
`;
  }

  const entries = modules.map(({ filePath, exportName, table }) => ({
    rel: importSpecifier(
      './' + path.relative(ctx.out, filePath).replace(/\\/g, '/'),
      opts.importExtension
    ),
    exportName,
    mount: mountPath(table, opts.naming),
  }));

  const imports = entries.map((e) => `import { ${e.exportName} } from '${e.rel}';`).join('\n');
  const chain = entries.map((e) => `  .route(${lit(e.mount)}, ${e.exportName})`).join('\n');
  const reExports = entries.map((e) => `export * from '${e.rel}';`).join('\n');

  return `// Generated by @drzl/generator-hono
import { Hono } from 'hono';
${imports}

export const app = new Hono()
${chain};

/** The type a Hono client is parameterised by: \`hc<AppType>('/')\`. */
export type AppType = typeof app;

${reExports}
`;
}
