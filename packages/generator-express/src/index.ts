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
 * Express routers, in Express's own idiom.
 *
 * Why this is a generator and not a template: the same reason `@drzl/generator-hono` is. A DRZL
 * "template" is `ORPCTemplateHooks`, and both shipped ones hand back oRPC source text
 * (`os.handler(...)`, `ORPCError`), none of which is Express, so an Express template written
 * against that interface would emit a file that does not compile.
 *
 * Why Express 5 only. The write stubs throw from async handlers, which is settled policy from the
 * Hono generator: the input is the insert shape, the declared response is the select shape, so
 * returning the input is a compile error and a bare throw says the work is not done. Express 5
 * routes a rejected handler promise to the error middleware and answers 500. Express 4 does not:
 * measured on express 4.22.2 under Node 22, the same stub is an unhandled promise rejection that
 * kills the whole process without a response. The emitted idiom is therefore only honest on 5,
 * and `express@latest` has been the 5.x line since 2024 (5.2.1 at the time of writing, with 4.x
 * parked on the `latest-4` tag).
 *
 * Why the validator middleware is emitted rather than installed. Express has no first-party
 * validator ecosystem the way Hono does: there is no `@express/standard-validator` to import.
 * The third-party options are AJV-based (`express-json-validator-middleware` 4.0.0 takes JSON
 * Schema and drags in ajv ^8), which would validate through a different pipeline from the zod,
 * valibot and arktype schemas every other DRZL router shares, with AJV's own looser coercion
 * rules. All three libraries DRZL emits implement Standard Schema v1 (measured on zod 4.4.3,
 * valibot 1.4.2 and arktype 2.2.3: every schema carries `~standard` with `version: 1` and a
 * `validate` function), so a ~30 line middleware over `schema['~standard'].validate` covers all
 * of them uniformly, and emitting it means zero added dependencies and no version to chase.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported router identifier. */
  routerSuffix?: string;
  /** Casing applied to file names, identifiers and the mounted URL segment. */
  procedureCase?: Case;
}

/** The barrel's filename stem, and the module the assembled app is exported from. */
export const APP_MODULE = 'index';

/** The emitted middleware's filename stem: `validate()` over Standard Schema v1. */
export const VALIDATION_MODULE = 'validation';

export interface GenerateOptions {
  outputDir: string;
  includeRelations?: boolean;
  naming?: NamingOptions;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /**
   * How every relative specifier this generator invents spells its extension: the barrel's import
   * of each route module, each module's import of the middleware, and `validation.importPath`.
   * Defaults to `'js'`, the only form that resolves under every `moduleResolution` without a
   * compiler flag.
   */
  importExtension?: ImportExtension;
  validation?: {
    useShared?: boolean;
    library?: 'zod' | 'valibot' | 'arktype';
    importPath?: string;
    schemaSuffix?: string;
    affix?: AffixOptions;
  };
}

type Lib = NonNullable<NonNullable<GenerateOptions['validation']>['library']>;

interface LibDialect {
  number: string;
  string: string;
  boolean: string;
  date: string;
  unknown: string;
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
   * A URL path segment is always a string: `GET /users/1` delivers `"1"`, so a `number` primary
   * key needs parsing before it matches the column. All three spellings are the *strict* ones,
   * taken unchanged from `@drzl/generator-hono`, which carries the measured grid this decision
   * rests on: the idiomatic coercions are built on `Number()`, and `Number('')` is `0`, so
   * `z.coerce.number()` and a bare `v.transform(Number)` accept `""`, `" "`, `"0x10"` and
   * `"1e5"`, and `GET /users/%20` would address row `0`. The strict forms reject all of those and
   * are the only spellings the three libraries agree on. One correction that grid recorded:
   * valibot's naive `v.pipe(v.string(), v.transform(Number), v.number())` does NOT accept `NaN`,
   * because `number()` rejects it; that pipe is merely too permissive elsewhere. The runtime spec
   * in this package re-measures the reject rows per library rather than trusting this comment.
   */
  coerce: (tsType: string) => string | null;
  /** The type of one parsed row, from the select schema. */
  infer: (schema: string) => string;
}

const q = (v: string) => JSON.stringify(v);

/**
 * A string literal in the emitted source, single-quoted where it can be.
 *
 * The formatter is an optional peer, so a project without prettier reads exactly these bytes, and
 * `JSON.stringify` would put double-quoted strings two lines below single-quoted imports.
 * Anything carrying a quote or a backslash falls back to `JSON.stringify`, which is correct for
 * every input.
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
 * is used. `noUnusedLocals` fails on an unused import, `verbatimModuleSyntax` keeps it, and a
 * module importing a package the consumer did not install throws on load rather than when the
 * unused thing is touched.
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
    unknown: 'z.unknown()',
    enum: (vals) => `z.enum([${vals.map(q).join(', ')}] as const)`,
    nullable: (b) => `${b}.nullable()`,
    optional: (b) => `${b}.optional()`,
    object: (body) => `z.object({\n${body}\n})`,
    objectInline: (body) => `z.object({ ${body} })`,
    partialUpdate: (s) => `${s}.partial()`,
    // Not `z.coerce.number()`, and not `z.coerce.date()`: both accept far more than a path
    // segment addressing a row should. See the grid referenced on `LibDialect.coerce`.
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
    unknown: 'v.unknown()',
    enum: (vals) => `v.picklist([${vals.map(q).join(', ')}] as const)`,
    nullable: (b) => `v.nullable(${b})`,
    optional: (b) => `v.optional(${b})`,
    object: (body) => `v.object({\n${body}\n})`,
    objectInline: (body) => `v.object({ ${body} })`,
    // A valibot pipe step sees the previous step's *output*, so the check has to happen while the
    // value is still the string: after a `v.transform(Number)` there is no string left to look at.
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
    unknown: 'unknown',
    // The surrounding encode adds the quotes, so the union is built with the inner quoting
    // ArkType expects.
    enum: (vals) => vals.map((x) => `'${x.replace(/'/g, "\\'")}'`).join(' | '),
    nullable: (b) => `(${b} | null)`,
    optional: (b) => `${b}?`,
    object: (body) => `type({\n${body}\n})`,
    objectInline: (body) => `type({ ${body} })`,
    fieldIsString: true,
    // ArkType ships these as keywords, and they are morphs: the declared output type is `number`,
    // not `string`. Returned bare, because `fieldIsString` quotes every expression this dialect
    // produces, and a keyword returned pre-quoted arrives as a string *literal* type matching
    // nothing but that sentence. `string.date.iso.parse` and not `string.date.parse`, which
    // accepts `"1"` as the year 2001.
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
 * A table with no primary key genuinely cannot be addressed. The key is read off `primaryKey`,
 * every column of it, at its real type, and a table without one loses the routes that would have
 * needed it rather than gaining a fictional `id`. A composite key keeps all of its columns, so
 * the path becomes `/:orgId/:userId`.
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
  return !['number', 'string', 'boolean', 'Date'].includes(column.tsType);
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
        return d.date;
      default:
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
 * The URL segment this table's router is mounted under: `/users`.
 *
 * `tsName` and not `name`: it is the identifier the user wrote in their schema, and lowercasing
 * `userProfiles` into `userprofiles` is not harmless on a public URL surface.
 * `naming.procedureCase: 'kebab'` is how you ask for `/user-profiles`, and unlike the export name
 * a URL segment can actually carry a hyphen.
 */
function mountPath(table: Table, naming?: NamingOptions): string {
  return `/${toCase(table.tsName, naming?.procedureCase)}`;
}

interface Route {
  /** For ordering only. */
  name: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  /** Middleware expressions, in the order Express runs them. */
  middleware: string[];
  /** The `Response<T>` annotation: the one place Express can hold a handler to its contract. */
  resType: string;
  body: string[];
}

interface RenderContext {
  /** Absolute output directory. */
  out: string;
}

export class ExpressGenerator {
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
    const modules: Array<{ table: Table; filePath: string; exportName: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    let anyValidates = false;
    for (const table of this.analysis.tables) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      // Both reserved names are refused up front, whether or not the middleware module will be
      // written on this run: a table that collides only when another table validates something
      // would make the failure depend on the rest of the schema.
      if (filePath === barrelPath || filePath === validationPath) {
        const which = filePath === barrelPath ? 'the barrel' : 'the validation middleware module';
        throw new Error(
          `@drzl/generator-express: the routes for table "${table.name}" would be written to ` +
            `${filePath}, which is ${which} this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
        );
      }
      const source = renderRoutes(table, opts, ctx);
      if (source.includes(`${VALIDATE_FN}('`)) anyValidates = true;
      await write(filePath, source);
      modules.push({ table, filePath, exportName: routesExportName(table, opts.naming) });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    // After the route modules, so the file list reads in dependency order, and only when some
    // module actually imports it: a schema of read-only keyless tables validates nothing, and a
    // middleware module nothing imports would still be compiled by the consumer's tsconfig.
    if (anyValidates) {
      await write(validationPath, renderValidationModule());
    }

    await write(barrelPath, renderBarrel(modules, ctx, path, opts));
    return { files };
  }
}

export default ExpressGenerator;

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

/** The emitted middleware's exported name. */
const VALIDATE_FN = 'validate';

/**
 * Where a stub finds the data the middleware just validated.
 *
 * Express hands nothing back through a method call the way Hono's `c.req.valid()` does, so the
 * middleware writes the parsed output over the slot it read: `req.params` for a path, `req.body`
 * for a body. Measured on express 5.2.1: an assignment to either inside route middleware survives
 * to the handlers behind it in the same chain, and `req.body` is a plain writable property that
 * body-parser itself assigns.
 */
const VALID_PARAM_HINT = '// validate() has already replaced req.params with the parsed values.';

/**
 * The middleware module: `validate()` over Standard Schema v1, emitted rather than installed.
 *
 * The interface is declared structurally and minimally instead of importing
 * `@standard-schema/spec`, so the generated tree adds no dependency; zod, valibot and arktype
 * schemas all satisfy it (measured at 4.4.3, 1.4.2 and 2.2.3). Two shapes in the result need
 * care, both measured: a path segment may be an object carrying `key` (valibot spells it that
 * way), and arktype's failure result is an array whose `issues` getter returns itself, which is
 * why the branch below asks for `.issues` rather than `Array.isArray`.
 */
function renderValidationModule(): string {
  return `// Generated by @drzl/generator-express
// A validation middleware over Standard Schema v1, so the same routes accept zod, valibot or
// arktype schemas. On failure it answers 400 with { error, slot, issues: [{ message, path }] };
// on success it replaces req[slot] with the parsed output and calls next().
import type { RequestHandler } from 'express';

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

export function ${VALIDATE_FN}(slot: 'params' | 'body', schema: StandardSchema): RequestHandler {
  return async (req, res, next) => {
    const result = await schema['~standard'].validate(req[slot]);
    if (result.issues) {
      res.status(400).json({
        error: 'Validation failed',
        slot,
        issues: result.issues.map((issue) => ({
          message: issue.message,
          path: (issue.path ?? []).map((p) => (typeof p === 'object' && p !== null ? p.key : p)),
        })),
      });
      return;
    }
    req[slot] = result.value as never;
    next();
  };
}
`;
}

function renderRoutes(table: Table, opts: GenerateOptions, ctx: RenderContext): string {
  const lib: Lib = (opts.validation?.library ?? 'zod') as Lib;
  const d = LIBS[lib];

  const insertName = `Insert${table.tsName}Schema`;
  const updateName = `Update${table.tsName}Schema`;
  const selectName = `Select${table.tsName}Schema`;
  // Not shared with the validation generators: a params schema is this generator's own invention,
  // because only a router knows that these particular columns arrive as path segments.
  const paramsName = `${cap(table.tsName)}ParamsSchema`;
  const rowType = `Select${table.tsName}Row`;

  // A materialized view refuses every write, so a create, update or delete route on one describes
  // an operation the database always rejects. The validation generators already omit the insert
  // and update schemas for a read-only table, so importing them here would import nothing.
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
    resType: `${rowType}[]`,
    // The stub states its own contract twice over: the annotated local is what a reader sees,
    // and the annotated res parameter is what Express's own types hold the handler to. Nothing
    // infers a client from either, which the docs say plainly; the types are for the person
    // filling the stub in.
    body: [`const rows: ${rowType}[] = [];`, 'res.json(rows);'],
  });

  if (key) {
    const keyPath = '/' + key.map((c) => `:${c.name}`).join('/');

    // byId ---------------------------------------------------------------------------------------
    routes.push({
      name: 'byId',
      method: 'get',
      path: keyPath,
      middleware: [`${VALIDATE_FN}('params', ${paramsName})`],
      resType: `${rowType} | null`,
      body: [VALID_PARAM_HINT, `const row: ${rowType} | null = null;`, 'res.json(row);'],
    });

    if (writable) {
      // update -----------------------------------------------------------------------------------
      // `json()` sits between the two validators: the params check spends nothing on a body the
      // key already rejects, and the body check cannot run before a parser has produced one.
      routes.push({
        name: 'update',
        method: 'patch',
        path: keyPath,
        middleware: [
          `${VALIDATE_FN}('params', ${paramsName})`,
          'json()',
          `${VALIDATE_FN}('body', ${updateName})`,
        ],
        resType: rowType,
        body: [notImplemented('update')],
      });

      // delete -----------------------------------------------------------------------------------
      routes.push({
        name: 'delete',
        method: 'delete',
        path: keyPath,
        middleware: [`${VALIDATE_FN}('params', ${paramsName})`],
        resType: 'boolean',
        body: [VALID_PARAM_HINT, 'res.json(true);'],
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
    // *select* shape, where they are required, so returning the input is a compile error and not
    // a loose placeholder. A body that only throws has type `never`, which honours any contract
    // and says plainly that the work is not done. Express 5 turns the rejection into a 500
    // through its error middleware; that behaviour is why this generator requires 5.
    routes.push({
      name: 'create',
      method: 'post',
      path: '/',
      middleware: ['json()', `${VALIDATE_FN}('body', ${insertName})`],
      resType: rowType,
      body: [notImplemented('create')],
    });
  }

  // relation lookups -----------------------------------------------------------------------------
  if (opts.includeRelations) {
    routes.push(...relationRoutes(table, lib, rowType, opts));
  }

  // Ordered so a reader finds CRUD where they expect it. Presentation only: Express matches `/`
  // and `/:id` unambiguously, so no ordering here changes which handler serves a request. The one
  // routing hazard is a *second* single-segment route, which is why the relation lookups carry a
  // literal prefix.
  const order = ['list', 'byId', 'create', 'update', 'delete'];
  const rank = (n: string) => (order.indexOf(n) === -1 ? order.length : order.indexOf(n));
  routes.sort((a, b) => rank(a.name) - rank(b.name));

  const exportName = routesExportName(table, opts.naming);

  // Statements, not a chain, and the difference from the Hono generator is deliberate. Hono
  // chains because `hc<AppType>()` only sees routes that accumulate through each call's return
  // type. Express infers nothing from a router's type, so nothing is lost by the form its own
  // documentation uses.
  const statements = routes
    .map((r) => {
      const args = [lit(r.path), ...r.middleware].join(', ');
      // Parameters are named for whether the body reads them; `noUnusedParameters` exempts a
      // leading underscore. Comment lines are excluded: the params hint mentions `req.params`,
      // and counting it as a read would emit an unused `req` that `noUnusedParameters` reports.
      // The res *type* is always stated, read or not: on a throwing stub it is the only place
      // the response contract exists.
      const reads = (what: RegExp) =>
        r.body.some((line) => !line.startsWith('//') && what.test(line));
      const reqParam = reads(/\breq\./) ? 'req' : '_req';
      const resParam = reads(/\bres\./) ? 'res' : '_res';
      return [
        `${exportName}.${r.method}(${args}, async (${reqParam}, ${resParam}: Response<${r.resType}>) => {`,
        ...r.body.map((line) => `  ${line}`),
        `});`,
      ].join('\n');
    })
    .join('\n\n');

  const body = `export const ${exportName} = Router();\n\n${statements}\n`;

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
    // or update schema, and the validation generators do not emit those for one, so importing
    // them would be an import that resolves to nothing.
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
      // specifier naming a package that does not exist.
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

  // Decided against the finished text, so a module carries only what it uses: `json` only where a
  // body is read, the middleware import only where a validator runs, and `Response` is inline
  // type-only so it never survives to runtime.
  const expressNames = ['Router'];
  if (decided.includes('json()')) expressNames.push('json');
  expressNames.push('type Response');
  imports.push(`import { ${expressNames.join(', ')} } from 'express';`);

  if (decided.includes(`${VALIDATE_FN}('`)) {
    // `importSpecifier` rewrites a TypeScript extension into the configured spelling, so it is
    // given one to rewrite.
    const spec = importSpecifier(`./${VALIDATION_MODULE}.ts`, opts.importExtension);
    imports.push(`import { ${VALIDATE_FN} } from '${spec}';`);
  }
  if (LIB_USAGE[lib].test(decided)) imports.unshift(LIB_IMPORTS[lib]);

  const wide = table.columns.filter(isWide).map((c) => c.name);
  const wideNote = wide.length
    ? `// No validated type for ${wide.length === 1 ? 'this column' : 'these columns'}: ${wide.join(', ')}.\n` +
      `// DRZL could not derive one from the schema, so these routes accept any value there.\n`
    : '';

  return `// Generated by @drzl/generator-express
// Routes for table: ${table.name}
${wideNote}${imports.join('\n')}

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
 * indistinguishable from the primary-key route: Express matches in declaration order, so
 * whichever of the two came second would never be reached.
 */
function relationRoutes(
  table: Table,
  lib: Lib,
  rowType: string,
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
      middleware: [`${VALIDATE_FN}('params', ${inline})`],
      resType: `${rowType}[]`,
      body: [VALID_PARAM_HINT, `const rows: ${rowType}[] = [];`, 'res.json(rows);'],
    });
  }
  return out;
}

/**
 * The barrel: one Express app with every table's router mounted, plus the modules re-exported so
 * a consumer can mount any single router into an app of their own.
 *
 * The app is a plain `express()` with nothing app-level on it: the JSON parser rides on each
 * write route, so a router mounted elsewhere still parses its own bodies, and no error middleware
 * is installed because Express 5's default already answers 500 for a rejected handler and 400 for
 * a body that fails to parse. There is no `AppType` and nothing to infer a client from; what a
 * consumer gets is typed handlers and the exported row types.
 */
function renderBarrel(
  modules: Array<{ table: Table; filePath: string; exportName: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions
): string {
  if (!modules.length) {
    return `// Generated by @drzl/generator-express
// No tables detected in analysis. Add tables to your schema and regenerate.
import express from 'express';

export const app = express();
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
  const mounts = entries
    .map((e) => `app.use(${lit(e.mount)}, ${e.exportName});`)
    .join('\n');
  const reExports = entries.map((e) => `export * from '${e.rel}';`).join('\n');

  return `// Generated by @drzl/generator-express
import express from 'express';
${imports}

export const app = express();

${mounts}

${reExports}
`;
}
