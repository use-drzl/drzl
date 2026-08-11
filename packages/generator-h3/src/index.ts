import { fileWriter, type FileSink } from '@drzl/validation-core';
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
 * h3 route handlers, one module per table, for Nitro and Nuxt.
 *
 * The version split is the whole design of this generator, and it is the opposite of the one the
 * MCP generator made. Established from the registry and from reading both type surfaces on
 * 2026-08-11:
 *
 *   h3 1.15.11   the `1x` tag, and what nitropack 2.13.4 depends on: `h3: ^1.15.11`
 *   h3 2.0.1-rc.26   the `latest` tag, and a release candidate
 *
 * So `npm install h3` gets a version no released Nitro uses, and every real Nuxt application is on
 * v1. `h3: 'v1'` is therefore the default here, where the MCP generator defaults to its *newer*
 * SDK: there the older one could not carry two of the three libraries at all, and here the older
 * one is simply what people have.
 *
 * The two differ in a way that reaches the emitted code. v2's `readValidatedBody` takes a Standard
 * Schema directly and adds `defineValidatedHandler`, which declares body, query and headers up
 * front. v1's takes a `ValidateFunction<T>`, which is `(data: unknown) => T | true | false | void`,
 * and has no Standard Schema overload at all: its own documentation suggests passing
 * `objectSchema.safeParse`, which is a zod-shaped idiom that valibot and arktype do not have.
 *
 * So under v1 the emitted modules carry a four-line adapter that turns any Standard Schema into
 * that function. It discriminates on `issues` rather than on the presence of `value`, and that is
 * load-bearing rather than stylistic: valibot's failure result carries a `value` key, so a check
 * written the other way reports every valibot failure as a success. That is not a hypothetical.
 * The Vercel AI SDK does exactly that, and `@drzl/generator-ai` emits a workaround for it.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported handler names. */
  routerSuffix?: string;
  /** Casing applied to file names, identifiers and the mounted URL segment. */
  procedureCase?: Case;
}

/** Which h3 major the emitted handlers are written against. See the module comment. */
export type H3Version = 'v1' | 'v2';

/** The barrel's filename stem, and the identifier it exports the assembled app as. */
export const APP_MODULE = 'index';

export interface GenerateOptions {
  outputDir: string;
  /** Which h3 major to emit for. Defaults to `'v1'`, which is what released Nitro depends on. */
  h3?: H3Version;
  naming?: NamingOptions;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /** How every relative specifier this generator invents spells its extension. Defaults to `'js'`. */
  importExtension?: ImportExtension;
  validation?: {
    useShared?: boolean;
    library?: 'zod' | 'valibot' | 'arktype';
    importPath?: string;
    schemaSuffix?: string;
    affix?: AffixOptions;
  };
  /** Where the generated files go, when that is not the filesystem. */
  fileSink?: FileSink;
}

type Lib = NonNullable<NonNullable<GenerateOptions['validation']>['library']>;

/** The few expressions this generator invents for itself, per library. */
interface LibDialect {
  number: string;
  string: string;
  boolean: string;
  dateInput: string;
  unknown: string;
  bigintWire: string;
  enum: (values: string[]) => string;
  objectInline: (body: string) => string;
  /** Whether every field expression is emitted as a quoted string, which ArkType alone needs. */
  fieldIsString?: boolean;
  ref: (name: string) => string;
  limit: string;
  offset: string;
  /** How a row type is inferred from the select schema. */
  infer: (schema: string) => string;
  /** The type-only import that inference needs, where it needs one. */
  inferImport: string;
}

const q = (v: string) => JSON.stringify(v);

const BIGINT_DIGITS = String.raw`/^-?\d+$/`;

const LIB_IMPORTS: Record<Lib, string> = {
  zod: "import { z } from 'zod';",
  valibot: "import * as v from 'valibot';",
  arktype: "import { type } from 'arktype';",
};

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
    dateInput: 'z.iso.datetime().transform((s) => new Date(s))',
    unknown: 'z.unknown()',
    bigintWire: `z.string().regex(${BIGINT_DIGITS})`,
    enum: (vals) => `z.enum([${vals.map(q).join(', ')}] as const)`,
    objectInline: (body) => `z.object({ ${body} })`,
    ref: (n) => n,
    limit: 'z.number().int().min(1).max(200).default(50)',
    offset: 'z.number().int().min(0).default(0)',
    infer: (s) => `z.output<typeof ${s}>`,
    inferImport: "import type { z } from 'zod';",
  },
  valibot: {
    number: 'v.number()',
    string: 'v.string()',
    boolean: 'v.boolean()',
    dateInput: 'v.pipe(v.string(), v.isoTimestamp(), v.transform((s) => new Date(s)))',
    unknown: 'v.unknown()',
    bigintWire: `v.pipe(v.string(), v.regex(${BIGINT_DIGITS}))`,
    enum: (vals) => `v.picklist([${vals.map(q).join(', ')}] as const)`,
    objectInline: (body) => `v.object({ ${body} })`,
    ref: (n) => n,
    limit: 'v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)), 50)',
    offset: 'v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0)',
    infer: (s) => `v.InferOutput<typeof ${s}>`,
    inferImport: "import type * as v from 'valibot';",
  },
  arktype: {
    number: 'number',
    string: 'string',
    boolean: 'boolean',
    dateInput: 'string.date.iso.parse',
    unknown: 'unknown',
    bigintWire: BIGINT_DIGITS,
    enum: (vals) => vals.map((x) => `'${x.replace(/'/g, "\\'")}'`).join(' | '),
    objectInline: (body) => `type({ ${body} })`,
    fieldIsString: true,
    ref: (n) => n,
    limit: JSON.stringify('1 <= number.integer <= 200 = 50'),
    offset: JSON.stringify('number.integer >= 0 = 0'),
    infer: (s) => `typeof ${s}.infer`,
    inferImport: '',
  },
};

/**
 * The adapter a v1 module carries, and the reason it exists.
 *
 * v1's `ValidateFunction<T>` is `(data: unknown) => T | true | false | void`, with no Standard
 * Schema overload, so a schema cannot be handed over directly. Returning the parsed value is what
 * makes the handler's argument typed; throwing an `H3Error` is what turns a bad payload into a 400
 * carrying the issues rather than a 500 carrying a stack.
 */
const V1_ADAPTER = 'drzlValidate';
const V1_ADAPTER_SOURCE = `/**
 * Any Standard Schema as h3 v1's \`ValidateFunction\`.
 *
 * v1 has no Standard Schema overload: its \`ValidateFunction<T>\` is
 * \`(data: unknown) => T | true | false | void\`, and h3's own documentation suggests passing
 * \`schema.safeParse\`, which is a zod-shaped idiom valibot and arktype do not have.
 *
 * The failure test is \`result.issues\` and not \`'value' in result\`, which matters more than it
 * looks: valibot's failure result carries a \`value\` key alongside its issues, so the second form
 * reports every valibot failure as a success. \`issues\` is the discriminator the Standard Schema
 * specification actually defines.
 */
function ${V1_ADAPTER}<T>(schema: StandardSchemaV1<unknown, T>) {
  return async (data: unknown): Promise<T> => {
    const result = await schema['~standard'].validate(data);
    if (result.issues) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Bad Request',
        data: { issues: result.issues },
      });
    }
    return result.value;
  };
}
`;

/**
 * The Standard Schema interface, spelled out rather than imported.
 *
 * `@standard-schema/spec` is a types-only package and adding it to a consumer's install for one
 * interface is a dependency for nothing. h3 v2 declares its own copy for the same reason, which is
 * where this shape is taken from.
 */
const STANDARD_SCHEMA_TYPE = `interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<{ readonly message: string }> }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: ReadonlyArray<{ readonly message: string }> }
        >;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}
`;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);

function keyColumns(table: Table): Column[] | null {
  const names = table.primaryKey?.columns ?? [];
  if (!names.length) return null;
  const cols = names.map((n) => table.columns.find((c) => c.name === n));
  if (cols.some((c) => !c)) return null;
  return cols as Column[];
}

/**
 * A router parameter's expression.
 *
 * A path segment is always a string, so a numeric key is checked and converted rather than declared
 * as a number: `z.number()` against `"1"` refuses every request. Not `z.coerce.number()` either,
 * which accepts an empty string as 0 and ` 1 ` as 1. Same grid the Hono generator measured.
 */
function paramExpr(column: Column, lib: Lib): string {
  const d = LIBS[lib];
  if (column.enumValues && column.enumValues.length) return d.enum(column.enumValues);
  switch (column.tsType) {
    case 'number':
      return lib === 'zod'
        ? String.raw`z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)`
        : lib === 'valibot'
          ? String.raw`v.pipe(v.string(), v.regex(/^-?\d+(\.\d+)?$/), v.transform(Number))`
          : 'string.numeric.parse';
    case 'Date':
      return d.dateInput;
    case 'bigint':
      return d.bigintWire;
    case 'boolean':
      // A path segment carrying a boolean is unusual enough that guessing a spelling would be
      // worse than keeping the string the request really sent.
      return d.string;
    default:
      return d.string;
  }
}

function objectKey(name: string): string {
  return isIdent(name) ? name : JSON.stringify(name);
}

function paramField(column: Column, lib: Lib): string {
  const d = LIBS[lib];
  const expr = paramExpr(column, lib);
  return `${objectKey(column.name)}: ${d.fieldIsString ? JSON.stringify(expr) : expr}`;
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

function handlerName(verb: string, table: Table, naming?: NamingOptions): string {
  const c = naming?.procedureCase;
  const base = toCase(`${table.tsName}${naming?.routerSuffix ?? ''}`, c === 'kebab' ? 'camel' : c);
  return `${verb}${cap(base)}`;
}

/** The URL segment this table's routes are mounted under: `/users`. */
function mountPath(table: Table, naming?: NamingOptions): string {
  return `/${toCase(table.tsName, naming?.procedureCase)}`;
}

/** `id`, or `orgId and userId` for a composite key. */
function keyPhrase(key: Column[]): string {
  const names = key.map((c) => c.name);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

interface Route {
  name: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  /** The path suffix under the table's mount point. */
  path: string;
  doc: string[];
  /** Statements before the body, reading and validating the request. */
  reads: string[];
  body: string[];
}

interface RenderContext {
  out: string;
}

export class H3Generator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions) {
    const lib: Lib = (opts.validation?.library ?? 'zod') as Lib;
    const version: H3Version = opts.h3 ?? 'v1';
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
    const modules: Array<{ table: Table; filePath: string; handlers: string[] }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      if (filePath === barrelPath) {
        throw new Error(
          `@drzl/generator-h3: the routes for table "${table.name}" would be written to ` +
            `${filePath}, which is the ${APP_MODULE}.ts this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
        );
      }
      const { text, handlers } = renderRoutes(table, opts, ctx, lib, version);
      await write(filePath, text);
      modules.push({ table, filePath, handlers });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    await write(barrelPath, renderBarrel(modules, ctx, path, opts, version));
    return { files };
  }
}

export default H3Generator;

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

/** What each version calls its handler factory and how it names a router parameter. */
const VERSIONS: Record<
  H3Version,
  { define: string; param: (name: string) => string; imports: string[] }
> = {
  v1: {
    define: 'defineEventHandler',
    // v1 routes with `:id`; v2 moved to `:id` as well, so this is shared rather than duplicated.
    param: (n) => `:${n}`,
    imports: ['createError', 'defineEventHandler', 'getValidatedQuery', 'getValidatedRouterParams', 'readValidatedBody'],
  },
  v2: {
    define: 'defineEventHandler',
    param: (n) => `:${n}`,
    imports: ['defineEventHandler', 'getValidatedQuery', 'getValidatedRouterParams', 'readValidatedBody'],
  },
};

function renderRoutes(
  table: Table,
  opts: GenerateOptions,
  ctx: RenderContext,
  lib: Lib,
  version: H3Version
): { text: string; handlers: string[] } {
  const d = LIBS[lib];
  const insertName = `Insert${table.tsName}Schema`;
  const updateName = `Update${table.tsName}Schema`;
  const selectName = `Select${table.tsName}Schema`;
  const paramsName = `${cap(table.tsName)}ParamsSchema`;
  const listName = `${cap(table.tsName)}QuerySchema`;
  const rowType = `${cap(table.tsName)}Row`;

  const writable = !table.readOnly;
  const key = keyColumns(table);

  /** How a schema reaches an h3 validation helper, which is the whole version difference. */
  const validated = (schema: string) => (version === 'v1' ? `${V1_ADAPTER}(${schema})` : schema);

  const routes: Route[] = [];

  routes.push({
    name: handlerName('list', table, opts.naming),
    method: 'get',
    path: '',
    doc: [`Read rows from the ${table.name} table.`],
    reads: [`const query = await getValidatedQuery(event, ${validated(listName)});`],
    body: [`void query;`, `const rows: ${rowType}[] = [];`, 'return rows;'],
  });

  if (key) {
    const keyPath = '/' + key.map((c) => VERSIONS[version].param(c.name)).join('/');
    routes.push({
      name: handlerName('get', table, opts.naming),
      method: 'get',
      path: keyPath,
      doc: [`Read one row of the ${table.name} table, addressed by ${keyPhrase(key)}.`],
      reads: [`const params = await getValidatedRouterParams(event, ${validated(paramsName)});`],
      body: [`void params;`, `const row: ${rowType} | null = null;`, 'return row;'],
    });

    if (writable) {
      routes.push({
        name: handlerName('update', table, opts.naming),
        method: 'patch',
        path: keyPath,
        doc: [`Change one row of the ${table.name} table, addressed by ${keyPhrase(key)}.`],
        reads: [
          `const params = await getValidatedRouterParams(event, ${validated(paramsName)});`,
          `const body = await readValidatedBody(event, ${validated(updateName)});`,
        ],
        body: [
          `void params;`,
          `void body;`,
          `throw new Error('Not implemented: update ${table.tsName}.');`,
        ],
      });

      routes.push({
        name: handlerName('delete', table, opts.naming),
        method: 'delete',
        path: keyPath,
        doc: [`Remove one row from the ${table.name} table, addressed by ${keyPhrase(key)}.`],
        reads: [`const params = await getValidatedRouterParams(event, ${validated(paramsName)});`],
        body: [`void params;`, `throw new Error('Not implemented: delete ${table.tsName}.');`],
      });
    }
  }

  if (writable) {
    routes.push({
      name: handlerName('create', table, opts.naming),
      method: 'post',
      path: '',
      doc: [`Insert one row into the ${table.name} table.`],
      reads: [`const body = await readValidatedBody(event, ${validated(insertName)});`],
      body: [`void body;`, `throw new Error('Not implemented: create ${table.tsName}.');`],
    });
  }

  const order = ['list', 'get', 'create', 'update', 'delete'];
  const rank = (n: string) => {
    const i = order.findIndex((v) => n.toLowerCase().startsWith(v));
    return i === -1 ? order.length : i;
  };
  routes.sort((a, b) => rank(a.name) - rank(b.name));

  const rendered = routes
    .map((r) =>
      [
        '/**',
        ...r.doc.map((l) => ` * ${l}`),
        ' *',
        ` * Mounted at \`${r.method.toUpperCase()} ${mountPath(table, opts.naming)}${r.path}\`.`,
        ' */',
        `export const ${r.name} = ${VERSIONS[version].define}(async (event) => {`,
        ...r.reads.map((l) => `  ${l}`),
        ...r.body.map((l) => `  ${l}`),
        `});`,
      ].join('\n')
    )
    .join('\n\n');

  const declared: string[] = [];
  if (key) {
    // The params schema is always declared, never imported: no validation generator emits one,
    // because only a router knows that these columns arrive as path segments.
    declared.push(
      `export const ${paramsName} = ${d.objectInline(
        key.map((c) => paramField(c, lib)).join(', ')
      )};`
    );
  }
  declared.push(
    `export const ${listName} = ${d.objectInline(`limit: ${d.limit}, offset: ${d.offset}`)};`
  );
  declared.push(`export type ${rowType} = ${d.infer(selectName)};`);

  const decided = [...declared, rendered].join('\n\n');

  const useShared = !!opts.validation?.useShared && !!opts.validation?.importPath;
  if (!useShared) {
    throw new Error(
      `@drzl/generator-h3: this generator has no schemas of its own to emit. Its handlers validate ` +
        `with the schemas a validation generator wrote, so it needs validation.useShared and ` +
        `validation.importPath pointing at that generator's output directory. Add a "zod", ` +
        `"valibot" or "arktype" generator to the config and point this one at its path.`
    );
  }

  const sharedAffix = resolveAffix({
    affix: opts.validation?.affix,
    schemaSuffix: opts.validation?.schemaSuffix,
  });
  const spec = resolveConfiguredImport(
    opts.validation!.importPath!,
    ctx.out,
    process.cwd(),
    opts.importExtension
  );
  const wanted: Array<['insert' | 'update' | 'select', string]> = (
    [
      ['insert', insertName],
      ['update', updateName],
      ['select', selectName],
    ] as Array<['insert' | 'update' | 'select', string]>
  ).filter(([, local]) => decided.includes(local));
  const names = wanted
    .map(([mode, local]) => {
      const exported = schemaName(mode, table.tsName, sharedAffix);
      return exported === local ? local : `${exported} as ${local}`;
    })
    .join(', ');

  // Decided against the finished text, so a module that never validates a body does not import
  // `readValidatedBody`. Same rule the Hono generator follows for its middleware. `createError` is
  // the exception: it is used by the v1 adapter's preamble rather than by any route.
  const needsAdapter = version === 'v1';
  const h3Names = VERSIONS[version].imports.filter(
    (n) => decided.includes(n) || (needsAdapter && n === 'createError')
  );
  const imports = [
    `import { ${h3Names.join(', ')} } from 'h3';`,
    `import { ${names} } from '${spec}';`,
  ];
  if (LIB_USAGE[lib].test(decided)) imports.unshift(LIB_IMPORTS[lib]);
  else if (d.inferImport) imports.push(d.inferImport);

  const preamble = needsAdapter ? `\n${STANDARD_SCHEMA_TYPE}\n${V1_ADAPTER_SOURCE}` : '';

  const text = `// Generated by @drzl/generator-h3
// Route handlers for table: ${table.name}
${imports.join('\n')}
${preamble}
${decided}`;

  return { text, handlers: routes.map((r) => r.name) };
}

function renderBarrel(
  modules: Array<{ table: Table; filePath: string; handlers: string[] }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions,
  version: H3Version
): string {
  const entries = modules.map((m) => ({
    table: m.table,
    rel: importSpecifier(
      './' + path.relative(ctx.out, m.filePath).replace(/\\/g, '/'),
      opts.importExtension
    ),
  }));
  const reExports = entries.map((e) => `export * from '${e.rel}';`).join('\n');

  /**
   * A route table rather than a mounted app, and that is the one thing this generator will not
   * guess. Nitro discovers handlers by file path under `server/routes`, Nuxt under
   * `server/api`, and a bare h3 project mounts them on a router by hand. Emitting one of those
   * three would be wrong for the other two, so the barrel says where each handler belongs and the
   * project decides how to mount it.
   */
  const rows = modules
    .flatMap((m) =>
      m.handlers.map((h) => `//   ${h.padEnd(24)} ${mountPath(m.table, opts.naming)}`)
    )
    .join('\n');

  return `// Generated by @drzl/generator-h3
// Every generated handler, re-exported.
//
// Deliberately not a mounted app. Nitro discovers handlers by file path under \`server/routes\`,
// Nuxt under \`server/api\`, and a bare h3 project mounts them on a router by hand, so any one of
// those choices would be wrong for the other two. Emitted for h3 ${version}.
//
// The routes, by handler:
${rows || '//   (no tables in the analysis)'}
${reExports || '// No tables in the analysis, so there is nothing to re-export.'}
`;
}
