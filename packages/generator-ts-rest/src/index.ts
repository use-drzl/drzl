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
 * ts-rest contracts, one module per table plus a root router.
 *
 * A ts-rest contract is a plain object: method, path, and a schema for each of body, path
 * parameters, query and every response status. Server and client are both derived from it, so the
 * contract is the whole artefact and there is no handler to stub.
 *
 * This generator requires `@ts-rest/core` 3.53.0-rc.0 or newer, which is a release candidate, and
 * that floor is not conservatism about a version number. Measured against the registry and against
 * both packages on 2026-08-11:
 *
 *   3.52.1        the `latest` tag, published 2025-03-04
 *   3.53.0-rc.1   published 2025-06-02, still a release candidate
 *
 * 3.52.1 declares `zod: ^3.22.3` as a peer dependency and types a contract's schemas as
 * `ContractAnyType = z.ZodSchema | ...`, where `z` is zod 3. DRZL's zod generator requires
 * `zod >=4.0.0`. Those two cannot be installed together: npm refuses the tree outright with
 * ERESOLVE, "Conflicting peer dependency: zod@3.25.76". So for a zod consumer the stable ts-rest is
 * not a worse target, it is an uninstallable one.
 *
 * For valibot and arktype it is worse than uninstallable, because it is quiet. 3.52.1 decides
 * whether a schema is a schema with `typeof obj?.safeParse === 'function'`, and anything failing
 * that test falls through `checkZodSchema` to `{ success: true, data }`. valibot and arktype expose
 * `~standard` but no `.safeParse` method, so a contract built from them validates nothing at all:
 * measured, `{ email: 12345, wat: true }` came back as a success with the unknown key intact. A
 * generator emitting that would produce a contract that looks validated and is not.
 *
 * 3.53.0-rc.1 adds `StandardSchemaV1` to `ContractAnyType`, drops the zod peer dependency
 * altogether, and validates through `~standard.validate`, discriminating on `issues` rather than on
 * the presence of `value`. That last detail is the one DRZL keeps having to check, because valibot's
 * failure result carries a `value` key alongside its issues and a check written the other way
 * reports every valibot failure as a success. ts-rest gets it right; the Vercel AI SDK does not,
 * which is why `@drzl/generator-ai` ships an adapter and this generator does not need one.
 *
 * TypeBox and Effect Schema are absent from the supported libraries for the reason oRPC's generator
 * gives: neither exposes `~standard` on the schema object, so a contract wired to one would type
 * against `any` and validate nothing. Measured on 2026-08-11 against `@sinclair/typebox` 0.34.52 and
 * `effect` 3.22.1. Effect Schema can be wrapped with `Schema.standardSchemaV1(...)`, but that is a
 * different artefact from the one `@drzl/generator-effect` writes, and `@drzl/generator-effect-http`
 * already serves Effect consumers with a native surface.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported contract name. */
  routerSuffix?: string;
  /** Casing applied to file names, identifiers and the mounted URL segment. */
  procedureCase?: Case;
}

/** The barrel's filename stem. */
export const CONTRACT_MODULE = 'index';

/** What the root contract is exported as, when `contractName` is not set. */
export const DEFAULT_CONTRACT_NAME = 'contract';

export interface GenerateOptions {
  outputDir: string;
  /** The identifier the root contract is exported as. Defaults to `'contract'`. */
  contractName?: string;
  /**
   * Prefixed to every path in the emitted contract, as ts-rest's own `pathPrefix` router option.
   *
   * Passed through to `c.router(..., { pathPrefix })` rather than baked into each path, because
   * ts-rest lifts the prefix into the contract's type and a client derived from it then reports the
   * full path. Writing it into the strings by hand would produce the same requests and a different
   * type.
   */
  pathPrefix?: string;
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
  string: string;
  unknown: string;
  bigintWire: string;
  enum: (values: string[]) => string;
  objectInline: (body: string) => string;
  /** Whether every field expression is emitted as a quoted string, which ArkType alone needs. */
  fieldIsString?: boolean;
  /** An array of the named schema, which is a response body for every list route. */
  array: (schema: string) => string;
  /**
   * A paging query parameter, which arrives as a string and converts. Not optional in itself: see
   * `optionalField`, which is where optionality is applied.
   */
  numericQuery: string;
  /**
   * One optional `key: value` pair of an object literal, rendered whole.
   *
   * Whole, because the three libraries do not put optionality in the same place. zod and valibot
   * wrap the value, ArkType marks the *key*: `type({ 'limit?': 'string' })`. Emitting
   * `type({ limit: 'string' })` and calling it optional is what a value-wrapping helper would have
   * produced, and it made every list route demand a paging parameter. Found by the compile test,
   * which passes `{ query: {} }`.
   */
  optionalField: (key: string, expr: string) => string;
}

const q = (v: string) => JSON.stringify(v);

const BIGINT_DIGITS = String.raw`/^-?\d+$/`;
const NUMERIC = String.raw`/^-?\d+(\.\d+)?$/`;

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
    string: 'z.string()',
    unknown: 'z.unknown()',
    bigintWire: `z.string().regex(${BIGINT_DIGITS})`,
    enum: (vals) => `z.enum([${vals.map(q).join(', ')}] as const)`,
    objectInline: (body) => `z.object({ ${body} })`,
    array: (s) => `z.array(${s})`,
    numericQuery: `z.string().regex(${NUMERIC}).transform(Number)`,
    optionalField: (k, e) => `${k}: ${e}.optional()`,
  },
  valibot: {
    string: 'v.string()',
    unknown: 'v.unknown()',
    bigintWire: `v.pipe(v.string(), v.regex(${BIGINT_DIGITS}))`,
    enum: (vals) => `v.picklist([${vals.map(q).join(', ')}] as const)`,
    objectInline: (body) => `v.object({ ${body} })`,
    array: (s) => `v.array(${s})`,
    numericQuery: `v.pipe(v.string(), v.regex(${NUMERIC}), v.transform(Number))`,
    optionalField: (k, e) => `${k}: v.optional(${e})`,
  },
  arktype: {
    string: 'string',
    unknown: 'unknown',
    bigintWire: BIGINT_DIGITS,
    enum: (vals) => vals.map((x) => `'${x.replace(/'/g, "\\'")}'`).join(' | '),
    objectInline: (body) => `type({ ${body} })`,
    fieldIsString: true,
    array: (s) => `${s}.array()`,
    numericQuery: 'string.numeric.parse',
    // The `?` goes on the key, which is the whole reason this is a dialect entry.
    optionalField: (k, e) => `${q(`${k}?`)}: ${q(e)}`,
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
 * as a number: `z.number()` against `"1"` refuses every request. Not `z.coerce.number()` either,
 * which accepts an empty string as 0. Same grid the Hono and h3 generators measured.
 */
function paramExpr(column: Column, lib: Lib): string {
  const d = LIBS[lib];
  if (column.enumValues && column.enumValues.length) return d.enum(column.enumValues);
  switch (column.tsType) {
    case 'number':
      return lib === 'zod'
        ? `z.string().regex(${NUMERIC}).transform(Number)`
        : lib === 'valibot'
          ? `v.pipe(v.string(), v.regex(${NUMERIC}), v.transform(Number))`
          : 'string.numeric.parse';
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

/** The exported contract identifier for one table: `usersContract`. */
function contractIdent(table: Table, naming?: NamingOptions): string {
  const c = naming?.procedureCase;
  const base = toCase(`${table.tsName}${naming?.routerSuffix ?? ''}`, c === 'kebab' ? 'camel' : c);
  return `${base}Contract`;
}

/** The key this table's contract takes on the root router, and its URL segment. */
function tableSegment(table: Table, naming?: NamingOptions): string {
  return toCase(table.tsName, naming?.procedureCase);
}

/** `id`, or `orgId and userId` for a composite key. */
function keyPhrase(key: Column[]): string {
  const names = key.map((c) => c.name);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

interface RenderContext {
  out: string;
}

export class TsRestGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions) {
    const lib: Lib = (opts.validation?.library ?? 'zod') as Lib;
    if (!opts.validation?.useShared || !opts.validation?.importPath) {
      throw new Error(
        `@drzl/generator-ts-rest: this generator has no schemas of its own to emit. A ts-rest ` +
          `contract is nothing but its schemas, so it needs validation.useShared and ` +
          `validation.importPath pointing at a validation generator's output directory. Add a ` +
          `"zod", "valibot" or "arktype" generator to the config and point this one at its path.`
      );
    }
    if (!(lib in LIBS)) {
      throw new Error(
        `@drzl/generator-ts-rest: validation.library is "${lib}", which cannot appear in a ts-rest ` +
          `contract. ts-rest types every schema as a Standard Schema, and neither TypeBox nor ` +
          `Effect Schema exposes "~standard" on the schema object, so the contract would type ` +
          `against any and validate nothing. Use "zod", "valibot" or "arktype". Effect consumers ` +
          `have a native surface in @drzl/generator-effect-http.`
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

    const barrelPath = path.join(out, `${CONTRACT_MODULE}.ts`);
    const modules: Array<{ table: Table; filePath: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      if (filePath === barrelPath) {
        throw new Error(
          `@drzl/generator-ts-rest: the contract for table "${table.name}" would be written to ` +
            `${filePath}, which is the ${CONTRACT_MODULE}.ts this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
        );
      }
      await write(filePath, renderContract(table, opts, ctx, lib));
      modules.push({ table, filePath });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    await write(barrelPath, renderBarrel(modules, ctx, path, opts));
    return { files };
  }
}

export default TsRestGenerator;

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

interface Route {
  /** The contract key, which is also what a client calls: `client.users.list(...)`. */
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** The path, relative to nothing: ts-rest paths are absolute. */
  path: string;
  summary: string;
  /** Contract entries beyond method, path and summary, in emission order. */
  extra: string[];
  responses: Array<[number, string]>;
}

function renderContract(
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
  const errorName = `${cap(table.tsName)}ErrorSchema`;

  const writable = !table.readOnly;
  const key = keyColumns(table);
  const segment = tableSegment(table, opts.naming);
  const basePath = `/${segment}`;
  const keyPath = key ? `${basePath}/${key.map((c) => `:${c.name}`).join('/')}` : '';

  const routes: Route[] = [];

  routes.push({
    name: 'list',
    method: 'GET',
    path: basePath,
    summary: `Read rows from the ${table.name} table.`,
    extra: [`query: ${queryName}`],
    responses: [[200, d.array(selectName)]],
  });

  if (key) {
    routes.push({
      name: 'byId',
      method: 'GET',
      path: keyPath,
      summary: `Read one row of the ${table.name} table, addressed by ${keyPhrase(key)}.`,
      extra: [`pathParams: ${paramsName}`],
      responses: [
        [200, selectName],
        [404, errorName],
      ],
    });
  }

  if (writable) {
    routes.push({
      name: 'create',
      method: 'POST',
      path: basePath,
      summary: `Insert one row into the ${table.name} table.`,
      extra: [`body: ${insertName}`],
      responses: [
        [201, selectName],
        [400, errorName],
      ],
    });

    if (key) {
      routes.push({
        name: 'update',
        method: 'PATCH',
        path: keyPath,
        summary: `Change one row of the ${table.name} table, addressed by ${keyPhrase(key)}.`,
        extra: [`pathParams: ${paramsName}`, `body: ${updateName}`],
        responses: [
          [200, selectName],
          [400, errorName],
          [404, errorName],
        ],
      });

      routes.push({
        name: 'remove',
        method: 'DELETE',
        path: keyPath,
        summary: `Remove one row from the ${table.name} table, addressed by ${keyPhrase(key)}.`,
        // No `body`, which is what makes this ts-rest's `AppRouteDeleteNoBody` rather than a
        // mutation whose body is required at the call site.
        extra: [`pathParams: ${paramsName}`],
        responses: [
          [200, errorName],
          [404, errorName],
        ],
      });
    }
  }

  const rendered = routes
    .map((r) =>
      [
        `  ${r.name}: {`,
        `    method: '${r.method}',`,
        `    path: '${r.path}',`,
        `    summary: ${q(r.summary)},`,
        ...r.extra.map((e) => `    ${e},`),
        `    responses: {`,
        ...r.responses.map(([code, schema]) => `      ${code}: ${schema},`),
        `    },`,
        `  },`,
      ].join('\n')
    )
    .join('\n');

  const contractVar = contractIdent(table, opts.naming);
  const body = `export const ${contractVar} = c.router({\n${rendered}\n});`;

  const declared: string[] = [];
  if (key) {
    // The params schema is always declared, never imported: no validation generator emits one,
    // because only a contract knows that these columns arrive as path segments.
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
  // Every failure response needs a body schema. ts-rest derives the client's discriminated union
  // from these, so a status with no schema is a status the client cannot narrow.
  declared.push(
    `export const ${errorName} = ${d.objectInline(
      `message: ${d.fieldIsString ? q(d.string) : d.string}`
    )};`
  );

  const decided = [...declared, body].join('\n\n');

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

  const imports = [
    `import { initContract } from '@ts-rest/core';`,
    `import { ${names} } from '${spec}';`,
  ];
  if (LIB_USAGE[lib].test(decided)) imports.unshift(LIB_IMPORTS[lib]);

  return `// Generated by @drzl/generator-ts-rest
// Contract for table: ${table.name}
${imports.join('\n')}

const c = initContract();

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
    table: m.table,
    ident: contractIdent(m.table, opts.naming),
    key: tableSegment(m.table, opts.naming),
    rel: importSpecifier(
      './' + path.relative(ctx.out, m.filePath).replace(/\\/g, '/'),
      opts.importExtension
    ),
  }));

  const imports = [
    `import { initContract } from '@ts-rest/core';`,
    ...entries.map((e) => `import { ${e.ident} } from '${e.rel}';`),
  ].join('\n');
  const reExports = entries.map((e) => `export * from '${e.rel}';`).join('\n');
  const members = entries.map((e) => `  ${objectKey(e.key)}: ${e.ident},`).join('\n');
  const name = opts.contractName ?? DEFAULT_CONTRACT_NAME;

  // `pathPrefix` is passed to `c.router` rather than written into each path, because ts-rest lifts
  // the prefix into the contract's type: a client derived from the result reports the full path.
  const options = opts.pathPrefix ? `, { pathPrefix: ${q(opts.pathPrefix)} }` : '';

  const router = entries.length
    ? `export const ${name} = c.router({\n${members}\n}${options});`
    : `export const ${name} = c.router({}${options});`;

  return `// Generated by @drzl/generator-ts-rest
// Every table's contract, assembled into one root contract.
//
// This is the whole artefact: \`initServer().router(${name}, { ... })\` implements it and
// \`initClient(${name}, { baseUrl })\` consumes it, both typed from this object alone.
//
// Requires @ts-rest/core 3.53.0-rc.0 or newer. Earlier versions type a contract's schemas as zod 3
// and cannot be installed beside the zod 4 DRZL emits; they also treat any schema without a
// \`.safeParse\` method as no schema at all, so a valibot or arktype contract would silently
// validate nothing.
${imports}

const c = initContract();

${router}

${reExports || '// No tables in the analysis, so there is nothing to re-export.'}
`;
}
