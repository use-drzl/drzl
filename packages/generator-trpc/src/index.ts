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
 * tRPC v11.
 *
 * Determined from the registry rather than from memory. `npm view @trpc/server dist-tags` puts
 * `latest` on 11.x, majors 1 through 11 are published and there is no 12 at all, and the `next`
 * tag points *behind* `latest`, so there is not even a v12 pre-release train to aim at. v11
 * reworked v10's builder internals and moved `createCaller` onto `t.createCallerFactory`, so a
 * generator written from a v10 memory would emit code that neither typechecks nor runs. Every
 * construct this file emits was executed against a real 11.x install before it was written down.
 */
export const TRPC_MAJOR = 11;

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  routerSuffix?: string;
  procedureCase?: Case;
}

/**
 * Which handler bodies the routers get.
 *
 * `standard` emits stubs. `service` delegates to the classes `@drzl/generator-service` writes, and
 * is the tRPC counterpart of pointing the oRPC generator at `@drzl/template-orpc-service`.
 *
 * Deliberately a closed set rather than oRPC's loadable template modules. `ORPCTemplateHooks`
 * hands back oRPC source text (`os.handler(...)`, `ORPCError`, `os.$context()`), none of which is
 * valid tRPC, so neither built-in template package can be reused here and a custom one written
 * against that interface would emit a file that does not compile. A hook API for tRPC should be
 * designed for tRPC rather than borrowed, so this ships without one instead of shipping one that
 * only appears to work.
 */
export type TemplateName = 'standard' | 'service';

export interface GenerateOptions {
  outputDir: string;
  template?: TemplateName;
  includeRelations?: boolean;
  naming?: NamingOptions;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /**
   * How every relative specifier this generator invents spells its extension: each router's
   * import of the shared base module, the barrel's import of each router, the service import and
   * `validation.importPath`. Defaults to `'js'`, the only form that resolves under every
   * `moduleResolution` without a compiler flag.
   */
  importExtension?: ImportExtension;
  validation?: {
    useShared?: boolean;
    library?: 'zod' | 'valibot' | 'arktype';
    importPath?: string;
    schemaSuffix?: string;
    /**
     * How the validation generator named its exports, which is what spells the names imported
     * from `importPath`. The CLI copies it from the sibling validation generator when unset, so
     * the two cannot drift. Local aliases stay `Insert<tsName>Schema`, so the router body reads
     * the same either way.
     */
    affix?: AffixOptions;
  };
  databaseInjection?: {
    enabled?: boolean;
    databaseType?: string;
    databaseTypeImport?: { name: string; from: string };
  };
  /** Where `@drzl/generator-service` is writing, for `template: 'service'`. */
  servicesDir?: string;
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

/**
 * Libraries a tRPC router can actually be built from.
 *
 * TypeBox is absent, and that is measured rather than assumed. tRPC v11 recognises a validator by
 * way of Standard Schema, and `@sinclair/typebox` 0.34 puts no `~standard` key on what
 * `Type.Object()` returns, so it is not a parser tRPC accepts. zod, valibot and arktype all carry
 * it, and all three were run through a real router before this list was written. The standalone
 * typebox generator is unaffected; it is only unusable here.
 */
type Lib = 'zod' | 'valibot' | 'arktype';

interface LibDialect {
  number: string;
  string: string;
  boolean: string;
  date: string;
  /**
   * A Date on the way in, which may or may not still be a Date by the time it arrives.
   *
   * tRPC's builder carries the transformer, and the base module this generator emits calls
   * `initTRPC.context<Context>().create()` with none. On that default the request is plain JSON, so
   * `JSON.stringify(new Date())` has already made the value a string and `z.date()` refuses it:
   * measured through the fetch adapter against exactly this configuration, both an ISO string and
   * an epoch number were rejected, so no valid call carrying a date column existed.
   *
   * A union rather than the ISO-only spelling the Express, Hono and NestJS generators use, because
   * those three serve JSON and this one might not. Adding `superjson` to the emitted base is the
   * documented tRPC answer for Dates, and it delivers a real `Date` to the procedure; an ISO-only
   * schema would then reject the value that transformer exists to carry. The union accepts both
   * wires and hands the resolver a `Date` either way, which is the only shape that does not make
   * this generator's correctness depend on a line the user is free to add.
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
  enum: (vals: string[]) => string;
  nullable: (base: string) => string;
  optional: (base: string) => string;
  object: (body: string) => string;
  /** The same object on one line. A key input reads better without the wrapping. */
  objectInline: (body: string) => string;
  tuple?: (length: number) => string;
  numberObject?: (fields: string[]) => string;
  /** ArkType field values are strings, so they are JSON-encoded rather than emitted bare. */
  fieldIsString?: boolean;
  /** Applied to the whole update schema, where the library has a shorthand for it. */
  partialUpdate?: (schema: string) => string;

  /**
   * The three below build a *JavaScript expression* out of a schema identifier, for `.input()`
   * and `.output()`. They are separate from `nullable` above, which builds a *field value*, and
   * for ArkType the two are genuinely different languages: a field is a quoted DSL fragment where
   * nullable is written `(X | null)`, while an expression is a `Type` object where the same thing
   * is `X.or('null')`. Emitting the field form into an expression position is a syntax error, and
   * it is the mistake the shape of this interface exists to make impossible.
   */
  arrayOf: (schema: string) => string;
  nullableOf: (schema: string) => string;
  booleanSchema: string;
}

const q = (v: string) => JSON.stringify(v);

/** The import each library's emitted expressions need, keyed the same way as `LIBS`. */
const LIB_IMPORTS: Record<Lib, string> = {
  zod: "import { z } from 'zod';",
  valibot: "import * as v from 'valibot';",
  arktype: "import { type } from 'arktype';",
};

/**
 * Whether a finished file body actually mentions a library, so its import is emitted only where
 * it is used.
 *
 * An unused import is not cosmetic here. `noUnusedLocals` fails on it, `verbatimModuleSyntax`
 * keeps it, and a module that imports a package the consumer did not install throws on load
 * rather than when the unused thing is touched. A router for a read-only table with no primary
 * key really does reference no `z.` at all, because every expression left in it is built from the
 * imported select schema.
 */
const LIB_USAGE: Record<Lib, RegExp> = {
  zod: /\bz\./,
  valibot: /\bv\./,
  arktype: /\btype\(/,
};

const LIBS: Record<Lib, LibDialect> = {
  zod: {
    number: 'z.number()',
    string: 'z.string()',
    boolean: 'z.boolean()',
    date: 'z.date()',
    dateInput: 'z.union([z.date(), z.iso.datetime().transform((s) => new Date(s))])',
    unknown: 'z.unknown()',
    json: 'z.json()',
    bigintWire: `z.string().regex(${BIGINT_DIGITS})`,
    binaryWire: 'z.base64().transform((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))',
    binaryRead: 'z.instanceof(Uint8Array)',
    tuple: (n) => `z.tuple([${Array.from({ length: n }, () => 'z.number()').join(', ')}])`,
    numberObject: (fields) => `z.object({ ${fields.map((f) => `${f}: z.number()`).join(', ')} })`,
    enum: (vals) => `z.enum([${vals.map(q).join(', ')}] as const)`,
    nullable: (b) => `${b}.nullable()`,
    optional: (b) => `${b}.optional()`,
    object: (body) => `z.object({\n${body}\n})`,
    objectInline: (body) => `z.object({ ${body} })`,
    partialUpdate: (s) => `${s}.partial()`,
    arrayOf: (s) => `z.array(${s})`,
    nullableOf: (s) => `${s}.nullable()`,
    booleanSchema: 'z.boolean()',
  },
  valibot: {
    number: 'v.number()',
    string: 'v.string()',
    boolean: 'v.boolean()',
    date: 'v.date()',
    dateInput:
      'v.union([v.date(), v.pipe(v.string(), v.isoTimestamp(), v.transform((s) => new Date(s)))])',
    unknown: 'v.unknown()',
    json: VALIBOT_JSON_CONST,
    bigintWire: `v.pipe(v.string(), v.regex(${BIGINT_DIGITS}))`,
    binaryWire:
      'v.pipe(v.string(), v.base64(), v.transform((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))))',
    binaryRead: 'v.instance(Uint8Array)',
    tuple: (n) => `v.tuple([${Array.from({ length: n }, () => 'v.number()').join(', ')}])`,
    numberObject: (fields) => `v.object({ ${fields.map((f) => `${f}: v.number()`).join(', ')} })`,
    enum: (vals) => `v.picklist([${vals.map(q).join(', ')}] as const)`,
    nullable: (b) => `v.nullable(${b})`,
    optional: (b) => `v.optional(${b})`,
    object: (body) => `v.object({\n${body}\n})`,
    objectInline: (body) => `v.object({ ${body} })`,
    arrayOf: (s) => `v.array(${s})`,
    nullableOf: (s) => `v.nullable(${s})`,
    booleanSchema: 'v.boolean()',
  },
  arktype: {
    number: 'number',
    string: 'string',
    boolean: 'boolean',
    date: 'Date',
    dateInput: 'Date | string.date.iso.parse',
    unknown: 'unknown',
    json: 'number | object | string | boolean | null',
    bigintWire: BIGINT_DIGITS,
    binaryWire: 'string.base64',
    binaryRead: 'TypedArray.Uint8',
    // The surrounding encode adds the quotes, so the union is built with the inner quoting
    // ArkType expects. Emitting `'${...}'` here produces `''admin' | 'user''`, which does not parse.
    enum: (vals) => vals.map((x) => `'${x.replace(/'/g, "\\'")}'`).join(' | '),
    nullable: (b) => `(${b} | null)`,
    optional: (b) => `${b}?`,
    object: (body) => `type({\n${body}\n})`,
    objectInline: (body) => `type({ ${body} })`,
    fieldIsString: true,
    arrayOf: (s) => `${s}.array()`,
    nullableOf: (s) => `${s}.or('null')`,
    booleanSchema: `type('boolean')`,
  },
};

/**
 * Whether the analyzer failed to give this column a type worth checking.
 *
 * Asked of the column rather than of the emitted expression, because by the time an expression
 * exists it has been wrapped in `nullable` and `optional` and no longer equals the library's
 * `unknown` token. A column in this state gets a validator that accepts anything, which is a real
 * hole in the router's contract, so the emitted file names them rather than leaving a reader to
 * spot one `z.unknown()` among forty fields.
 */
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
    if (column.shape?.kind === 'tuple' && d.tuple) return d.tuple(column.shape.length);
    if (column.shape?.kind === 'numberObject' && d.numberObject) {
      return d.numberObject(column.shape.fields);
    }
    switch (column.tsType) {
      case 'number':
        return d.number;
      case 'string':
        return d.string;
      case 'boolean':
        return d.boolean;
      case 'Date':
        // The read side is a real Date the driver produced. The write side depends on the
        // transformer, so it takes both; see `LibDialect.dateInput`.
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

/**
 * One `name: <expr>` entry, with the library's field encoding applied.
 *
 * The key is quoted only where it has to be. A column named with anything that is not a bare
 * identifier produces invalid object syntax unquoted, which is why the sibling generators quote
 * unconditionally; quoting only when needed matters here because a formatter is an *optional*
 * peer, so the unquoted-where-possible form is what a consumer without prettier actually reads,
 * and this generator puts a whole key object on one line where the difference shows.
 */
function field(column: Column, lib: Lib, mode: 'insert' | 'update' | 'select'): string {
  const d = LIBS[lib];
  const expr = mapExpr(column, lib, mode);
  return `${objectKey(column.name)}: ${d.fieldIsString ? JSON.stringify(expr) : expr}`;
}

function objectKey(name: string): string {
  return isIdent(name) ? name : JSON.stringify(name);
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const singularize = (s: string) =>
  s.endsWith('ies') ? s.slice(0, -3) + 'y' : s.endsWith('s') ? s.slice(0, -1) : s;
const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);

/** The module every router imports its `router` and procedure builders from. */
export const BASE_MODULE = 'trpc';

/**
 * The columns that address one row, or `null` when nothing does.
 *
 * A table with no primary key genuinely cannot be addressed, and the oRPC generator's answer is
 * to emit `z.object({ id: z.number() })` regardless, which names a column that may not exist and
 * types it as a number when it may be a uuid. That is not reproduced here: the key is read off
 * `primaryKey`, every column of it, at its real type, and a table without one loses the
 * procedures that would have needed it rather than gaining a fictional `id`.
 *
 * A composite key keeps all of its columns, so `byId` takes `{ orgId, userId }`. The procedure is
 * still called `byId`: the alternative is a client surface whose procedure names change with the
 * shape of a key, and a caller holding the key does not care how many parts it has.
 */
function keyColumns(table: Table): Column[] | null {
  const names = table.primaryKey?.columns ?? [];
  if (!names.length) return null;
  const cols = names.map((n) => table.columns.find((c) => c.name === n));
  if (cols.some((c) => !c)) return null;
  return cols as Column[];
}

interface Procedure {
  /** The exported key, before `procedureCase` is applied. */
  name: string;
  /** `query` for a read, `mutation` for a write. */
  kind: 'query' | 'mutation';
  input?: string;
  output: string;
  /** The handler's parameter list, `''` when it needs nothing. */
  params: string;
  body: string[];
}

/** Everything the render functions need that is only knowable once paths are resolved. */
interface RenderContext {
  /** Absolute output directory. */
  out: string;
  /** Absolute services directory, for `template: 'service'`. */
  services: string;
}

export class TRPCGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions) {
    const fs = fileWriter(opts.fileSink);
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outputDir);
    const ctx: RenderContext = {
      out,
      services: path.resolve(process.cwd(), opts.servicesDir ?? 'src/services'),
    };
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

    // The base is emitted whether or not there are tables: it is what a consumer imports to stand
    // a server up, and an empty schema is one that will not stay empty.
    const basePath = path.join(out, `${BASE_MODULE}.ts`);
    await write(basePath, renderBase(opts));

    const routers: Array<{ table: Table; filePath: string; exportName: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      if (filePath === basePath) {
        throw new Error(
          `@drzl/generator-trpc: the router for table "${table.name}" would be written to ` +
            `${filePath}, which is the shared tRPC base module this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
        );
      }
      await write(filePath, renderRouter(table, opts, ctx));
      routers.push({ table, filePath, exportName: routerExportName(table, opts.naming) });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    await write(path.join(out, 'index.ts'), renderBarrel(routers, ctx, path, opts));
    return { files };
  }
}

export default TRPCGenerator;

/**
 * The one `initTRPC` instance the whole generated tree shares.
 *
 * This file has no counterpart in the oRPC output and is the largest structural difference
 * between the two generators. oRPC's `os` is a free import from `@orpc/server`, so every router
 * file can build procedures without coordinating with any other. tRPC's builder carries the
 * context type, the transformer and the error formatter with it, so a router built from its own
 * `initTRPC.create()` is a router with its own context type: merging two of them is unsound and
 * middleware cannot be shared across them at all. Every tRPC project has exactly one of these,
 * and a generated tree is not an exception.
 */
function renderBase(opts: GenerateOptions): string {
  const injection = opts.databaseInjection?.enabled === true;
  const dbType = opts.databaseInjection?.databaseType ?? 'unknown';
  const typeImport = opts.databaseInjection?.databaseTypeImport
    ? `import type { ${opts.databaseInjection.databaseTypeImport.name} } from '${opts.databaseInjection.databaseTypeImport.from}';\n`
    : '';

  // `TRPCError` is referenced only by the database middleware, so it is imported only with it.
  const trpcImport = injection
    ? `import { initTRPC, TRPCError } from '@trpc/server';`
    : `import { initTRPC } from '@trpc/server';`;

  const context = injection
    ? `/**
 * What your \`createContext\` hands every procedure.
 *
 * \`db\` is optional here and required by \`dbProcedure\` below. That split is what lets an adapter
 * build a context without a handle, for a health check or a public route, while every generated
 * procedure still sees one that is present.
 */
export interface Context {
  db?: ${dbType};
}`
    : `/**
 * What your \`createContext\` hands every procedure. Nothing generated reads it, so it is left
 * open; narrow it to the shape your own context really has.
 */
export type Context = Record<string, unknown>;`;

  const middleware = injection
    ? `
/**
 * The builder every generated procedure is built from: it refuses to run without a database
 * handle, and narrows \`ctx.db\` from optional to present for everything downstream.
 */
export const dbProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.db) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'No database handle on the tRPC context. Provide one from createContext.',
    });
  }
  return next({ ctx: { db: ctx.db } });
});
`
    : '';

  return `// Generated by @drzl/generator-trpc
// The shared tRPC base. Every generated router imports from here.
${trpcImport}
${typeImport}
${context}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const mergeRouters = t.mergeRouters;
export const middleware = t.middleware;
/** Needed to call this router in-process, from a test or from SSR. */
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;
${middleware}`;
}

function renderRouter(table: Table, opts: GenerateOptions, ctx: RenderContext): string {
  const lib: Lib = (opts.validation?.library ?? 'zod') as Lib;
  const d = LIBS[lib];
  const service = opts.template === 'service';
  const injection = opts.databaseInjection?.enabled === true;
  const builder = injection ? 'dbProcedure' : 'publicProcedure';

  const insertName = `Insert${table.tsName}Schema`;
  const updateName = `Update${table.tsName}Schema`;
  const selectName = `Select${table.tsName}Schema`;

  // A materialized view refuses every write, so a create, update or delete procedure on one
  // describes an operation the database always rejects, and its insert and update schemas
  // describe rows that can never be written. The validation generators already omit those
  // schemas for a read-only table, so importing them here would import nothing.
  const writable = !table.readOnly;
  const key = keyColumns(table);

  const Service = `${cap(singularize(table.tsName))}Service`;
  // `@drzl/generator-service` types its key parameters from the primary key itself: one
  // parameter per key column, in key order, at the column's real type. A call composed from the
  // input object therefore typechecks whenever every key column has a type the input schema can
  // spell (`field()` above: number, string, boolean, Date, or an enum's literals). A column the
  // analyzer could not type arrives in the input as `unknown`, which the service's typed
  // parameter does not accept, so rather than emit a call that does not compile, or drop the
  // procedures and give every table a differently shaped client, those fall back to the
  // throwing stub the standard template uses.
  const serviceKeyable = !!key && key.every(serviceKeyExpressible);
  const keyArg = key ? key.map((c) => `input.${c.name}`).join(', ') : '';
  const dbArg = injection ? 'ctx.db, ' : '';
  const wiredParams = injection ? '{ ctx, input }' : '{ input }';

  const procedures: Procedure[] = [];
  const notImplemented = (what: string) =>
    `throw new Error('Not implemented: ${what} ${table.tsName}.');`;

  // list ---------------------------------------------------------------------------------------
  procedures.push({
    name: 'list',
    kind: 'query',
    output: d.arrayOf(selectName),
    params: service && injection ? '{ ctx }' : '',
    body: service ? [`return await ${Service}.getAll(${injection ? 'ctx.db' : ''});`] : ['return [];'],
  });

  const keyInput = key
    ? d.objectInline(key.map((c) => field(c, lib, 'select')).join(', '))
    : undefined;

  if (key && keyInput) {
    const wired = service && serviceKeyable;

    // byId -------------------------------------------------------------------------------------
    procedures.push({
      name: 'byId',
      kind: 'query',
      input: keyInput,
      output: d.nullableOf(selectName),
      params: wired ? wiredParams : '{ input: _input }',
      body: wired
        ? [`return await ${Service}.getById(${dbArg}${keyArg});`]
        : service
          ? [serviceKeyNote(table), notImplemented('byId')]
          : ['return null;'],
    });

    if (writable) {
      // update ---------------------------------------------------------------------------------
      const updateInput = d.objectInline(
        [...key.map((c) => field(c, lib, 'select')), `data: ${updateName}`].join(', ')
      );
      procedures.push({
        name: 'update',
        kind: 'mutation',
        input: updateInput,
        output: selectName,
        params: wired ? wiredParams : '{ input: _input }',
        body: wired
          ? [`return await ${Service}.update(${dbArg}${keyArg}, input.data);`]
          : service
            ? [serviceKeyNote(table), notImplemented('update')]
            : [notImplemented('update')],
      });

      // delete ---------------------------------------------------------------------------------
      procedures.push({
        name: 'delete',
        kind: 'mutation',
        input: keyInput,
        output: d.booleanSchema,
        params: wired ? wiredParams : '{ input: _input }',
        body: wired
          ? [`return await ${Service}.delete(${dbArg}${keyArg});`]
          : service
            ? [serviceKeyNote(table), notImplemented('delete')]
            : ['return true;'],
      });
    }
  }

  if (writable) {
    // create -------------------------------------------------------------------------------------
    // Emitted with or without a primary key: inserting a row does not require being able to
    // address one afterwards.
    //
    // The stub throws rather than returning the input. The input is the *insert* shape, where
    // generated and defaulted columns are optional, and `.output()` declares the *select* shape,
    // where they are required. tRPC typechecks a handler's return against its output parser,
    // measured, so returning the input is a compile error and not a loose placeholder. A body
    // that only throws has type `never`, which honours any contract and says plainly that the
    // work is not done.
    procedures.push({
      name: 'create',
      kind: 'mutation',
      input: insertName,
      output: selectName,
      params: service ? wiredParams : '{ input: _input }',
      body: service
        ? [`return await ${Service}.create(${dbArg}input);`]
        : [notImplemented('create')],
    });
  }

  // relation lookups -----------------------------------------------------------------------------
  if (opts.includeRelations) {
    const taken = new Set(procedures.map((p) => p.name));
    procedures.push(...relationProcedures(table, lib, selectName, taken, service));
  }

  // Ordered so a reader finds the CRUD set where they expect it, independent of the order the
  // branches above happened to push them in.
  const order = ['list', 'byId', 'create', 'update', 'delete'];
  const rank = (n: string) => (order.indexOf(n) === -1 ? order.length : order.indexOf(n));
  procedures.sort((a, b) => rank(a.name) - rank(b.name));

  const routerName = routerExportName(table, opts.naming);
  const entries = procedures
    .map((p) => {
      const rawKey = toCase(p.name, opts.naming?.procedureCase);
      const propKey = isIdent(rawKey) ? rawKey : JSON.stringify(rawKey);
      return [
        `  ${propKey}: ${builder}`,
        ...(p.input ? [`    .input(${p.input})`] : []),
        `    .output(${p.output})`,
        `    .${p.kind}(async (${p.params}) => {`,
        ...p.body.map((line) => `      ${line}`),
        `    }),`,
      ].join('\n');
    })
    .join('\n');

  const body = `export const ${routerName} = router({\n${entries}\n});\n`;

  const useShared = !!opts.validation?.useShared && !!opts.validation?.importPath;
  const declared: string[] = [];
  if (!useShared) {
    if (writable) {
      declared.push(`export const ${insertName} = ${renderSchema(table, lib, 'insert')};`);
      declared.push(`export const ${updateName} = ${renderSchema(table, lib, 'update')};`);
    }
    declared.push(`export const ${selectName} = ${renderSchema(table, lib, 'select')};`);
  }

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
      // `importPath` is resolved against the directory the routers are written to. Emitting it
      // verbatim turns a project-relative value such as `src/validators/zod`, which is how the
      // rest of the config names directories, into a *bare* specifier naming a package that does
      // not exist, and the import resolves to nothing.
      const spec = resolveConfiguredImport(
        opts.validation!.importPath!,
        ctx.out,
        process.cwd(),
        opts.importExtension
      );
      const names = wanted
        .map(([mode, local]) => {
          const exported = schemaName(mode, table.tsName, sharedAffix);
          // With no affix configured the exported name already *is* the local alias, and the
          // oRPC generator emits `X as X` for it regardless. Harmless, and still noise in a file
          // a user reads, so the alias appears only when it renames something.
          return exported === local ? local : `${exported} as ${local}`;
        })
        .join(', ');
      imports.push(`import { ${names} } from '${spec}';`);
    }
  }

  imports.push(
    `import { ${[builder, 'router'].sort().join(', ')} } from '${importSpecifier(
      `./${BASE_MODULE}.ts`,
      opts.importExtension
    )}';`
  );

  if (service) {
    imports.push(`import { ${Service} } from '${serviceImportSpecifier(table, ctx, opts)}';`);
  }

  // Decided against the finished text, which is the only thing that knows whether the library
  // survived into it.
  if (LIB_USAGE[lib].test(decided)) imports.unshift(LIB_IMPORTS[lib]);

  // The valibot json value space, emitted once into any module that references it. Decided against
  // the finished text rather than from the column list, which is the same rule the imports above
  // follow: a module that mentions the name defines it, and one that does not stays as it was.
  const jsonPreamble = decided.includes(VALIBOT_JSON_CONST) ? `\n${VALIBOT_JSON_SOURCE}` : '';

  const wide = table.columns.filter(isWide).map((c) => c.name);
  const wideNote = wide.length
    ? `// No validated type for ${wide.length === 1 ? 'this column' : 'these columns'}: ${wide.join(', ')}.\n` +
      `// DRZL could not derive one from the schema, so the router accepts any value there.\n`
    : '';

  return `// Generated by @drzl/generator-trpc
// Router for table: ${table.name}
${wideNote}${imports.join('\n')}
${jsonPreamble}
${decided}`;
}

/**
 * One lookup per single-column foreign key: `listByAuthorId({ authorId })`.
 *
 * Named after the column, not the referenced table, because two keys frequently point at the same
 * table (`authorId` and `editorId` both referencing `users`) and naming by table would emit one
 * key twice.
 *
 * Restricted to single-column keys returning rows of *this* table, whose select schema is already
 * in scope. The inverse direction, which returns another table's rows, is deliberately absent: it
 * needs the other router module's select schema, that import is circular whenever both directions
 * exist, and a cycle between router modules costs more in tRPC than in oRPC. It is not only a
 * load-order problem there but a typing one, because `typeof appRouter` is what a client infers
 * its entire API from, and a circular router graph resolves to `any` or to TS7022. The lookups are
 * absent rather than half-working.
 */
function relationProcedures(
  table: Table,
  lib: Lib,
  selectSchemaName: string,
  taken: Set<string>,
  service: boolean
): Procedure[] {
  const d = LIBS[lib];
  const out: Procedure[] = [];
  for (const fk of table.foreignKeys ?? []) {
    if (fk.columns.length !== 1) continue;
    const colName = fk.columns[0];
    const column = table.columns.find((c) => c.name === colName);
    if (!column) continue;

    const name = `listBy${cap(colName)}`;
    if (taken.has(name)) continue;
    taken.add(name);

    out.push({
      name,
      kind: 'query',
      input: d.objectInline(field(column, lib, 'select')),
      output: d.arrayOf(selectSchemaName),
      params: '{ input: _input }',
      body: [
        `// Rows of ${table.name} whose ${JSON.stringify(colName)} matches _input.${colName}.`,
        // In `service` mode every other procedure really does reach the database, so a lookup
        // quietly answering with an empty array would read as "no matching rows". There is no
        // generated service method for it, so it says so instead. In `standard` mode everything
        // is a stub and `[]` is consistent with `list`.
        service ? `throw new Error('Not implemented: ${name} ${table.tsName}.');` : 'return [];',
      ],
    });
  }
  return out;
}

/**
 * The barrel, which in tRPC is not a barrel.
 *
 * oRPC's index file exports a plain object literal. This one calls `router()` on the per-table
 * routers, because a nested tRPC router is a router rather than an object, and it exports
 * `type AppRouter`: that type is the entire client contract, the thing
 * `createTRPCClient<AppRouter>()` is parameterised by, and without it the generated tree is a
 * server with no way to talk to it.
 */
function renderBarrel(
  routers: Array<{ table: Table; filePath: string; exportName: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions
): string {
  const baseSpec = importSpecifier(`./${BASE_MODULE}.ts`, opts.importExtension);
  const reExports =
    `export { createCallerFactory, publicProcedure, router } from '${baseSpec}';\n` +
    (opts.databaseInjection?.enabled === true
      ? `export { dbProcedure } from '${baseSpec}';\n`
      : '') +
    `export type { Context } from '${baseSpec}';\n`;

  if (!routers.length) {
    return `// Generated by @drzl/generator-trpc
// No tables detected in analysis. Add tables to your schema and regenerate.
import { router } from '${baseSpec}';

export const appRouter = router({});

/** The type a tRPC client is parameterised by: \`createTRPCClient<AppRouter>()\`. */
export type AppRouter = typeof appRouter;

${reExports}`;
  }

  const entries = routers.map(({ filePath, exportName, table }) => ({
    rel: importSpecifier(
      './' + path.relative(ctx.out, filePath).replace(/\\/g, '/'),
      opts.importExtension
    ),
    exportName,
    // The namespace a client reaches this table's procedures through: `trpc.userProfiles.list`.
    // `tsName` verbatim, because it is already a valid identifier and it is the name the user
    // wrote in their schema. The oRPC barrel lowercases this key, turning `userProfiles` into
    // `userprofiles`: harmless in an object literal nobody reads, and not harmless when the key
    // is the public API of a typed client.
    key: table.tsName,
  }));

  const importLines = entries
    .map(({ rel, exportName }) => `import { ${exportName} } from '${rel}';`)
    .join('\n');
  const bodyLines = entries
    .map(({ key, exportName }) => `  ${isIdent(key) ? key : JSON.stringify(key)}: ${exportName},`)
    .join('\n');

  return `// Generated by @drzl/generator-trpc
import { router } from '${baseSpec}';
${importLines}

export const appRouter = router({
${bodyLines}
});

/** The type a tRPC client is parameterised by: \`createTRPCClient<AppRouter>()\`. */
export type AppRouter = typeof appRouter;

${reExports}`;
}

/**
 * Whether the generated input schema can type this key column, which is exactly when the
 * emitted service call typechecks: `field()` spells number, string, boolean, Date and enum
 * literals, and everything else becomes `z.unknown()`, which the service's typed key parameter
 * does not accept.
 */
function serviceKeyExpressible(c: Column): boolean {
  if (c.enumValues && c.enumValues.length) return true;
  return ['number', 'string', 'boolean', 'Date'].includes(c.tsType);
}

/** Why a service-backed procedure is a stub, stated in the file rather than only in the docs. */
function serviceKeyNote(table: Table): string {
  const cols = table.primaryKey?.columns ?? [];
  const untyped = cols.filter((n) => {
    const c = table.columns.find((x) => x.name === n);
    return !c || !serviceKeyExpressible(c);
  });
  const what =
    untyped.length === 1 ? `its column ${untyped[0]}` : `its columns ${untyped.join(', ')}`;
  return (
    `// ${table.name} is keyed on (${cols.join(', ')}) and DRZL cannot type ${what}: the input\n` +
    `// schema carries unknown there, which the service's typed key parameter does not accept.\n` +
    `// Wire this to your own lookup.`
  );
}

function routerExportName(table: Table, naming?: NamingOptions): string {
  const base = `${table.tsName}${naming?.routerSuffix ?? 'Router'}`;
  const c = naming?.procedureCase;
  // Kebab is not a valid identifier; fall back to camel for an exported const.
  return toCase(base, c === 'kebab' ? 'camel' : c);
}

/**
 * Spell the import of a generated service module.
 *
 * `path.relative` returns a bare `services` whenever the services directory sits inside the router
 * output directory, and a specifier without a leading `./` is a *bare* specifier: Node looks for a
 * package of that name and never considers the directory next door. The prefix is added explicitly
 * rather than relying on what `path.relative` happens to return, and the extension goes through
 * the same helper every other specifier here uses.
 */
function serviceImportSpecifier(table: Table, ctx: RenderContext, opts: GenerateOptions): string {
  const rel = relativePosix(ctx.out, ctx.services);
  const dir = !rel ? '.' : rel.startsWith('.') ? rel : `./${rel}`;
  return importSpecifier(`${dir}/${singularize(table.tsName)}Service.ts`, opts.importExtension);
}

/**
 * `path.relative`, without importing `node:path` at module scope.
 *
 * This package is bundled to ESM and CJS by tsup and its one entry point is a class whose methods
 * `await import()` what they need, so nothing here may reach for `require`. The two inputs are
 * always absolute paths produced by `path.resolve`, which is a small enough contract to satisfy
 * directly.
 */
function relativePosix(from: string, to: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const a = norm(from).split('/');
  const b = norm(to).split('/');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...Array.from({ length: a.length - i }, () => '..'), ...b.slice(i)].join('/');
}

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
