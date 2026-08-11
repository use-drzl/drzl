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
 * Elysia routes, one mounted module per table.
 *
 * This is the first DRZL router generator that can use TypeBox, and the reason is that Elysia's own
 * `t` *is* TypeBox. Its validator slot is `AnySchema = TSchema | StandardSchemaV1Like`, so it takes
 * a TypeBox schema natively and anything carrying `~standard` as well. Measured against
 * `elysia@1.4.29` on 2026-08-11: all four of typebox, zod, valibot and arktype compile, and all four
 * reject an invalid body at runtime with a 422 carrying a structured error.
 *
 * TypeBox is nonetheless not the default, and that is a measured decision rather than a preference.
 * `@sinclair/typebox` ships separate `.d.ts` and `.d.mts` declarations, and its schema types are
 * branded with `unique symbol`s, so the two copies produce types that are not assignable to each
 * other. Elysia's own declarations are CommonJS. Under `moduleResolution: node16` or `nodenext` a
 * consumer's ESM import resolves to the `.d.mts` copy while Elysia's slot refers to the `.d.ts` one,
 * and a `TObject` stops matching `TSchema`: it falls through to `StandardSchemaV1Like` and is
 * rejected for having no `~standard`. Reproduced with a single installed copy of
 * `@sinclair/typebox@0.34.52`, so it is not a duplicate-install problem and nothing here can fix it.
 * It compiles cleanly under `bundler`, which is what Bun projects use, so the option is worth
 * having. zod, valibot and arktype compile under all three resolutions, so zod is the default, and
 * the incompatibility is pinned by a must-fire test rather than only described here.
 *
 * That last part is worth stating because it is not the norm. h3 v1 needed an emitted adapter to
 * validate at all, the Vercel AI SDK needs one to avoid reporting every valibot failure as a
 * success, and `@ts-rest/core` 3.52.1 passes an unrecognised schema straight through as valid.
 * Elysia does the discrimination correctly for every library, so this generator emits no adapter.
 *
 * Two measured details shape what is emitted. `t.Numeric()` is Elysia's own coercing spelling for a
 * numeric path segment and does not exist in `@sinclair/typebox`, where `Type.Numeric` is
 * `undefined`, so the TypeBox dialect imports `t` from `'elysia'` even though the table schemas
 * beside it come from `@sinclair/typebox`. And ArkType alone keeps unknown keys where zod, valibot
 * and TypeBox all strip them, which is a difference in what the handler receives rather than in what
 * is accepted.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported module identifier. */
  routerSuffix?: string;
  /** Casing applied to file names, identifiers and the mounted URL segment. */
  procedureCase?: Case;
}

/** The barrel's filename stem. */
export const APP_MODULE = 'index';

/** What the assembled app is exported as, when `appName` is not set. */
export const DEFAULT_APP_NAME = 'app';

export interface GenerateOptions {
  outputDir: string;
  /** The identifier the assembled Elysia app is exported as. Defaults to `'app'`. */
  appName?: string;
  /**
   * Prefixed to every table's mount point, as Elysia's own `prefix` on the root app.
   *
   * Passed to `new Elysia({ prefix })` rather than baked into each module's own prefix, because
   * Elysia lifts the prefix into the app's type: a route's full path is what Eden Treaty reports.
   */
  prefix?: string;
  naming?: NamingOptions;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /** How every relative specifier this generator invents spells its extension. Defaults to `'js'`. */
  importExtension?: ImportExtension;
  validation?: {
    useShared?: boolean;
    library?: 'zod' | 'valibot' | 'arktype' | 'typebox';
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
  string: string;
  bigintWire: string;
  enum: (values: string[]) => string;
  objectInline: (body: string) => string;
  /** Whether every field expression is emitted as a quoted string, which ArkType alone needs. */
  fieldIsString?: boolean;
  /** A numeric path segment, which arrives as a string. */
  numericParam: string;
  /** A paging query parameter, and how optionality is applied to it. */
  numericQuery: string;
  optionalField: (key: string, expr: string) => string;
  /** How a row type is inferred from the select schema. */
  infer: (schema: string) => string;
  /** The type-only import that inference needs, where it needs one. */
  inferImport: string;
  /** The value import the emitted expressions need, if any. */
  valueImport: string;
  /** Matches the emitted text when this library's value import is actually used. */
  usage: RegExp;
}

const q = (v: string) => JSON.stringify(v);

const BIGINT_DIGITS = String.raw`/^-?\d+$/`;
const NUMERIC = String.raw`/^-?\d+(\.\d+)?$/`;

const LIBS: Record<Lib, LibDialect> = {
  zod: {
    string: 'z.string()',
    bigintWire: `z.string().regex(${BIGINT_DIGITS})`,
    enum: (vals) => `z.enum([${vals.map(q).join(', ')}] as const)`,
    objectInline: (body) => `z.object({ ${body} })`,
    numericParam: `z.string().regex(${NUMERIC}).transform(Number)`,
    numericQuery: `z.string().regex(${NUMERIC}).transform(Number)`,
    optionalField: (k, e) => `${k}: ${e}.optional()`,
    infer: (s) => `z.output<typeof ${s}>`,
    inferImport: "import type { z } from 'zod';",
    valueImport: "import { z } from 'zod';",
    usage: /\bz\./,
  },
  valibot: {
    string: 'v.string()',
    bigintWire: `v.pipe(v.string(), v.regex(${BIGINT_DIGITS}))`,
    enum: (vals) => `v.picklist([${vals.map(q).join(', ')}] as const)`,
    objectInline: (body) => `v.object({ ${body} })`,
    numericParam: `v.pipe(v.string(), v.regex(${NUMERIC}), v.transform(Number))`,
    numericQuery: `v.pipe(v.string(), v.regex(${NUMERIC}), v.transform(Number))`,
    optionalField: (k, e) => `${k}: v.optional(${e})`,
    infer: (s) => `v.InferOutput<typeof ${s}>`,
    inferImport: "import type * as v from 'valibot';",
    valueImport: "import * as v from 'valibot';",
    usage: /\bv\./,
  },
  arktype: {
    string: 'string',
    bigintWire: BIGINT_DIGITS,
    enum: (vals) => vals.map((x) => `'${x.replace(/'/g, "\\'")}'`).join(' | '),
    objectInline: (body) => `type({ ${body} })`,
    fieldIsString: true,
    numericParam: 'string.numeric.parse',
    numericQuery: 'string.numeric.parse',
    // The `?` goes on the key, not around the value, which is ArkType's alone.
    optionalField: (k, e) => `${q(`${k}?`)}: ${q(e)}`,
    infer: (s) => `typeof ${s}.infer`,
    inferImport: '',
    valueImport: "import { type } from 'arktype';",
    usage: /\btype\(/,
  },
  typebox: {
    string: 't.String()',
    // `t.RegExp` exists, but a bigint crossing a URL is checked the same way everywhere else here.
    bigintWire: `t.RegExp(${BIGINT_DIGITS})`,
    enum: (vals) => `t.UnionEnum([${vals.map(q).join(', ')}] as const)`,
    objectInline: (body) => `t.Object({ ${body} })`,
    // Elysia's own coercing number. `Type.Numeric` is undefined in `@sinclair/typebox`, which is
    // why this dialect imports `t` from 'elysia' rather than reusing the standalone generator's.
    numericParam: 't.Numeric()',
    numericQuery: 't.Numeric()',
    optionalField: (k, e) => `${k}: t.Optional(${e})`,
    infer: (s) => `Static<typeof ${s}>`,
    inferImport: "import type { Static } from '@sinclair/typebox';",
    valueImport: "import { t } from 'elysia';",
    usage: /\bt\./,
  },
};

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
 * A path parameter's expression.
 *
 * A path segment is always a string, so a numeric key is checked and converted rather than declared
 * as a number. TypeBox gets Elysia's `t.Numeric()`, which is the framework's own spelling for
 * exactly this; the other three get the regex and transform the Hono generator measured first.
 */
function paramExpr(column: Column, lib: Lib): string {
  const d = LIBS[lib];
  if (column.enumValues && column.enumValues.length) return d.enum(column.enumValues);
  switch (column.tsType) {
    case 'number':
      return d.numericParam;
    case 'bigint':
      return d.bigintWire;
    default:
      // Including Date and boolean. A path segment carrying either is unusual enough that guessing
      // a spelling would be worse than keeping the string the request really sent.
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

/** The exported module identifier for one table: `usersRoutes`. */
function moduleIdent(table: Table, naming?: NamingOptions): string {
  const c = naming?.procedureCase;
  const base = toCase(`${table.tsName}${naming?.routerSuffix ?? ''}`, c === 'kebab' ? 'camel' : c);
  return `${base}Routes`;
}

/** The URL segment this table's routes are mounted under. */
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
  method: 'get' | 'post' | 'patch' | 'delete';
  /** The path within this table's mounted module. */
  path: string;
  doc: string[];
  /** The destructured context keys the handler reads. */
  context: string[];
  /** The hook object's entries: `params`, `query`, `body`. */
  hooks: string[];
  body: string[];
}

interface RenderContext {
  out: string;
}

export class ElysiaGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions) {
    const lib: Lib = (opts.validation?.library ?? 'zod') as Lib;
    if (!opts.validation?.useShared || !opts.validation?.importPath) {
      throw new Error(
        `@drzl/generator-elysia: this generator has no schemas of its own to emit. Its routes ` +
          `validate with the schemas a validation generator wrote, so it needs ` +
          `validation.useShared and validation.importPath pointing at that generator's output ` +
          `directory. Add a "typebox", "zod", "valibot" or "arktype" generator to the config and ` +
          `point this one at its path.`
      );
    }
    if (!(lib in LIBS)) {
      throw new Error(
        `@drzl/generator-elysia: validation.library is "${lib}", which Elysia cannot validate ` +
          `with. Its validator slot takes a TypeBox schema or anything carrying "~standard", so ` +
          `use "typebox", "zod", "valibot" or "arktype".`
      );
    }

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
    const modules: Array<{ table: Table; filePath: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      if (filePath === barrelPath) {
        throw new Error(
          `@drzl/generator-elysia: the routes for table "${table.name}" would be written to ` +
            `${filePath}, which is the ${APP_MODULE}.ts this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
        );
      }
      await write(filePath, renderRoutes(table, opts, ctx, lib));
      modules.push({ table, filePath });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    await write(barrelPath, renderBarrel(modules, ctx, path, opts));
    return { files };
  }
}

export default ElysiaGenerator;

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

function renderRoutes(
  table: Table,
  opts: GenerateOptions,
  ctx: RenderContext,
  lib: Lib
): string {
  const d = LIBS[lib];
  const insertName = `Insert${table.tsName}Schema`;
  const updateName = `Update${table.tsName}Schema`;
  const selectName = `Select${table.tsName}Schema`;
  const paramsName = `${cap(table.tsName)}ParamsSchema`;
  const queryName = `${cap(table.tsName)}QuerySchema`;
  const rowType = `${cap(table.tsName)}Row`;

  const writable = !table.readOnly;
  const key = keyColumns(table);
  const keyPath = key ? '/' + key.map((c) => `:${c.name}`).join('/') : '';

  const routes: Route[] = [];

  routes.push({
    method: 'get',
    path: '/',
    doc: [`Read rows from the ${table.name} table.`],
    context: ['query'],
    hooks: [`query: ${queryName}`],
    body: ['void query;', `const rows: ${rowType}[] = [];`, 'return rows;'],
  });

  if (key) {
    routes.push({
      method: 'get',
      path: keyPath,
      doc: [`Read one row of the ${table.name} table, addressed by ${keyPhrase(key)}.`],
      context: ['params'],
      hooks: [`params: ${paramsName}`],
      body: ['void params;', `const row: ${rowType} | null = null;`, 'return row;'],
    });

    if (writable) {
      routes.push({
        method: 'patch',
        path: keyPath,
        doc: [`Change one row of the ${table.name} table, addressed by ${keyPhrase(key)}.`],
        context: ['params', 'body'],
        hooks: [`params: ${paramsName}`, `body: ${updateName}`],
        body: [
          'void params;',
          'void body;',
          `throw new Error('Not implemented: update ${table.tsName}.');`,
        ],
      });

      routes.push({
        method: 'delete',
        path: keyPath,
        doc: [`Remove one row from the ${table.name} table, addressed by ${keyPhrase(key)}.`],
        context: ['params'],
        hooks: [`params: ${paramsName}`],
        body: ['void params;', `throw new Error('Not implemented: delete ${table.tsName}.');`],
      });
    }
  }

  if (writable) {
    routes.push({
      method: 'post',
      path: '/',
      doc: [`Insert one row into the ${table.name} table.`],
      context: ['body'],
      hooks: [`body: ${insertName}`],
      body: ['void body;', `throw new Error('Not implemented: create ${table.tsName}.');`],
    });
  }

  const order: Array<Route['method']> = ['get', 'post', 'patch', 'delete'];
  routes.sort((a, b) => {
    const byMethod = order.indexOf(a.method) - order.indexOf(b.method);
    return byMethod !== 0 ? byMethod : a.path.length - b.path.length;
  });

  const moduleVar = moduleIdent(table, opts.naming);
  const chain = routes
    .map((r) =>
      [
        `  /**`,
        ...r.doc.map((l) => `   * ${l}`),
        `   *`,
        `   * Mounted at \`${r.method.toUpperCase()} ${mountPath(table, opts.naming)}${
          r.path === '/' ? '' : r.path
        }\`.`,
        `   */`,
        `  .${r.method}('${r.path}', ({ ${r.context.join(', ')} }) => {`,
        ...r.body.map((l) => `    ${l}`),
        `  }, {`,
        ...r.hooks.map((h) => `    ${h},`),
        `  })`,
      ].join('\n')
    )
    .join('\n');

  const app = `export const ${moduleVar} = new Elysia({ prefix: ${q(
    mountPath(table, opts.naming)
  )} })\n${chain};`;

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
    `export const ${queryName} = ${d.objectInline(
      ['limit', 'offset'].map((k) => d.optionalField(k, d.numericQuery)).join(', ')
    )};`
  );
  declared.push(`export type ${rowType} = ${d.infer(selectName)};`);

  const decided = [...declared, app].join('\n\n');

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

  /**
   * The imports, decided against the finished text rather than assumed.
   *
   * `noUnusedLocals` is on in the compile tests, so a module that never spells `z.` must not import
   * `z`. In practice the query schema always does, but deciding it from `decided` is what keeps that
   * true if the emitted set ever narrows.
   *
   * TypeBox is the one dialect whose value import is not its own package. `t` is Elysia's extension
   * of TypeBox and is what carries `t.Numeric()`, so it arrives from `'elysia'` alongside `Elysia`
   * itself, while the row type still needs `Static` from `@sinclair/typebox`.
   */
  const usesLib = d.usage.test(decided);
  const imports =
    lib === 'typebox'
      ? [
          usesLib ? "import { Elysia, t } from 'elysia';" : "import { Elysia } from 'elysia';",
          d.inferImport,
          `import { ${names} } from '${spec}';`,
        ]
      : [
          "import { Elysia } from 'elysia';",
          usesLib ? d.valueImport : d.inferImport,
          `import { ${names} } from '${spec}';`,
        ];

  return `// Generated by @drzl/generator-elysia
// Routes for table: ${table.name}
${imports.filter(Boolean).join('\n')}

${decided}
`;
}

function renderBarrel(
  modules: Array<{ table: Table; filePath: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions
): string {
  const entries = modules.map((m) => ({
    ident: moduleIdent(m.table, opts.naming),
    rel: importSpecifier(
      './' + path.relative(ctx.out, m.filePath).replace(/\\/g, '/'),
      opts.importExtension
    ),
  }));

  const imports = [
    `import { Elysia } from 'elysia';`,
    ...entries.map((e) => `import { ${e.ident} } from '${e.rel}';`),
  ].join('\n');
  const reExports = entries.map((e) => `export * from '${e.rel}';`).join('\n');
  const name = opts.appName ?? DEFAULT_APP_NAME;

  // `prefix` on the root app rather than folded into each module's own, because Elysia lifts it
  // into the app's type: the full path is what Eden Treaty reports.
  const ctor = opts.prefix ? `new Elysia({ prefix: ${q(opts.prefix)} })` : 'new Elysia()';
  const uses = entries.map((e) => `  .use(${e.ident})`).join('\n');

  const assembled = entries.length
    ? `export const ${name} = ${ctor}\n${uses};`
    : `export const ${name} = ${ctor};`;

  return `// Generated by @drzl/generator-elysia
// Every table's routes, mounted on one app.
//
// A real mounted app, unlike the h3 generator's barrel, and the difference is that Elysia has one
// way to compose: \`.use()\` on a root instance, which carries each module's routes onto the
// assembled type. Serve it with \`${name}.listen(3000)\` under Bun, or hand \`${name}.handle\` a
// \`Request\` anywhere else.
${imports}

${assembled}

/** The assembled app's type, which is what Eden Treaty derives a client from. */
export type App = typeof ${name};

${reExports || '// No tables in the analysis, so there is nothing to re-export.'}
`;
}
