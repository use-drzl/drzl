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
 * Effect Platform `HttpApi` groups, one per table.
 *
 * The missing half of a story DRZL already half told. `@drzl/generator-effect` emits Effect Schema
 * modules and stops there, so a project using them had the types and had to hand-write every
 * endpoint that carries one. `HttpApiEndpoint.post('create', '/').setPayload(InsertusersSchema)` is
 * a two-line wrapper around a schema that already exists, repeated five times per table.
 *
 * The one thing worth knowing before reading the output: a **path parameter is a string**, so a
 * numeric key is declared `Schema.NumberFromString` rather than `Schema.Number`. Declaring the
 * latter refuses every request, since `"1"` is not a number. Effect happens to name the conversion
 * cleanly, where zod and valibot need a regex and a transform spelled out; the mistake underneath
 * is the same one, and it is the one the Hono generator measured first.
 *
 * This is the only DRZL generator with no per-library dialect, because Effect Schema is the only
 * library `HttpApi` accepts. There is nothing here to choose.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported group identifier. */
  routerSuffix?: string;
  /** Casing applied to file names, identifiers and the mounted URL prefix. */
  procedureCase?: Case;
}

/** The barrel's filename stem, and the identifier it exports the assembled API as. */
export const API_MODULE = 'index';

export interface GenerateOptions {
  outputDir: string;
  /** The identifier the assembled `HttpApi` carries. Defaults to `'api'`. */
  apiName?: string;
  naming?: NamingOptions;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /** How every relative specifier this generator invents spells its extension. Defaults to `'js'`. */
  importExtension?: ImportExtension;
  validation?: {
    useShared?: boolean;
    /**
     * Named for symmetry with the other generators and accepted only as `'effect'`.
     *
     * `HttpApi` declares its payloads as Effect Schema and takes nothing else, so there is no
     * choice to offer here. A config naming another library is refused rather than silently
     * emitting endpoints that will not compile.
     */
    library?: 'effect';
    importPath?: string;
    schemaSuffix?: string;
    affix?: AffixOptions;
  };
  /** Where the generated files go, when that is not the filesystem. */
  fileSink?: FileSink;
}

/** The namespace the emitted modules import Effect Schema under, matching @drzl/generator-effect. */
const NS = 'Schema';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
const lit = (v: string) => (/['\\]/.test(v) ? JSON.stringify(v) : `'${v}'`);

function keyColumns(table: Table): Column[] | null {
  const names = table.primaryKey?.columns ?? [];
  if (!names.length) return null;
  const cols = names.map((n) => table.columns.find((c) => c.name === n));
  if (cols.some((c) => !c)) return null;
  return cols as Column[];
}

/**
 * A path parameter's schema.
 *
 * `Schema.NumberFromString` and not `Schema.Number`, because a path segment is always a string and
 * declaring it a number refuses every request. Effect names the conversion for the two cases that
 * have one; a column type without a conversion keeps the string it was given rather than being
 * checked against a type no path segment can ever carry.
 */
function paramSchema(column: Column): string {
  if (column.enumValues && column.enumValues.length) {
    return `${NS}.Literal(${column.enumValues.map((v) => JSON.stringify(v)).join(', ')})`;
  }
  switch (column.tsType) {
    case 'number':
      return `${NS}.NumberFromString`;
    case 'bigint':
      return `${NS}.BigIntFromString`;
    case 'Date':
      return `${NS}.Date`;
    default:
      return `${NS}.String`;
  }
}

function objectKey(name: string): string {
  return isIdent(name) ? name : JSON.stringify(name);
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

/** The exported group: `usersGroup`, with `kebab` falling back to camel. */
function groupName(table: Table, naming?: NamingOptions): string {
  const c = naming?.procedureCase;
  const base = toCase(`${table.tsName}${naming?.routerSuffix ?? ''}`, c === 'kebab' ? 'camel' : c);
  return `${base}Group`;
}

/** The URL prefix this table's endpoints are mounted under, and the group's own identifier. */
function mountPath(table: Table, naming?: NamingOptions): string {
  return `/${toCase(table.tsName, naming?.procedureCase)}`;
}

interface Endpoint {
  /**
   * The endpoint identifier, which is how a client addresses it: `client.users.delete(...)`.
   *
   * Not the same as `local` below, and `delete` is why. A property name may be a reserved word and
   * a variable name may not, so emitting `const delete = ...` is a syntax error while
   * `client.users.delete` is perfectly ordinary. Keeping the two apart is what lets the wire name
   * stay the obvious one.
   */
  name: string;
  /** The identifier the endpoint is bound to inside the module. */
  local: string;
  factory: 'get' | 'post' | 'patch' | 'del';
  path: string;
  doc: string;
  /** Chained calls, in the order Effect's builder takes them. */
  chain: string[];
}

interface RenderContext {
  out: string;
}

export class EffectHttpGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions) {
    const library = opts.validation?.library ?? 'effect';
    if (library !== 'effect') {
      throw new Error(
        `@drzl/generator-effect-http: validation.library is "${library}", and HttpApi declares its ` +
          `payloads as Effect Schema and takes nothing else. Set validation.library to "effect" ` +
          `and point validation.importPath at an "effect" generator's output directory.`
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

    const barrelPath = path.join(out, `${API_MODULE}.ts`);
    const modules: Array<{ table: Table; filePath: string; group: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      if (filePath === barrelPath) {
        throw new Error(
          `@drzl/generator-effect-http: the endpoints for table "${table.name}" would be written ` +
            `to ${filePath}, which is the ${API_MODULE}.ts this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
        );
      }
      await write(filePath, renderGroup(table, opts, ctx));
      modules.push({ table, filePath, group: groupName(table, opts.naming) });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    await write(barrelPath, renderBarrel(modules, ctx, path, opts));
    return { files };
  }
}

export default EffectHttpGenerator;

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

/** `id`, or `orgId and userId` for a composite key. */
function keyPhrase(key: Column[]): string {
  const names = key.map((c) => c.name);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function renderGroup(table: Table, opts: GenerateOptions, ctx: RenderContext): string {
  const insertName = `Insert${table.tsName}Schema`;
  const updateName = `Update${table.tsName}Schema`;
  const selectName = `Select${table.tsName}Schema`;
  const paramsName = `${cap(table.tsName)}ParamsSchema`;
  const queryName = `${cap(table.tsName)}QuerySchema`;

  const writable = !table.readOnly;
  const key = keyColumns(table);
  const endpoints: Endpoint[] = [];

  endpoints.push({
    name: 'list',
    local: 'list',
    factory: 'get',
    path: '/',
    doc: `Read rows from the ${table.name} table.`,
    chain: [`.setUrlParams(${queryName})`, `.addSuccess(${NS}.Array(${selectName}))`],
  });

  if (key) {
    const keyPath = '/' + key.map((c) => `:${c.name}`).join('/');
    endpoints.push({
      name: 'byId',
      local: 'byId',
      factory: 'get',
      path: keyPath,
      doc: `Read one row of the ${table.name} table, addressed by ${keyPhrase(key)}.`,
      chain: [`.setPath(${paramsName})`, `.addSuccess(${NS}.NullOr(${selectName}))`],
    });

    if (writable) {
      endpoints.push({
        name: 'update',
        local: 'update',
        factory: 'patch',
        path: keyPath,
        doc: `Change one row of the ${table.name} table, addressed by ${keyPhrase(key)}.`,
        chain: [
          `.setPath(${paramsName})`,
          `.setPayload(${updateName})`,
          `.addSuccess(${selectName})`,
        ],
      });

      endpoints.push({
        name: 'delete',
        // `remove`, because `delete` cannot be a variable name.
        local: 'remove',
        factory: 'del',
        path: keyPath,
        doc: `Remove one row from the ${table.name} table, addressed by ${keyPhrase(key)}.`,
        // `HttpApiEndpoint.del` and not `delete`, which is a reserved word and so cannot be a
        // property name Effect could export.
        chain: [`.setPath(${paramsName})`, `.addSuccess(${NS}.Boolean)`],
      });
    }
  }

  if (writable) {
    endpoints.push({
      name: 'create',
      local: 'create',
      factory: 'post',
      path: '/',
      doc: `Insert one row into the ${table.name} table.`,
      chain: [`.setPayload(${insertName})`, `.addSuccess(${selectName})`],
    });
  }

  const order = ['list', 'byId', 'create', 'update', 'delete'];
  endpoints.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

  const declared = endpoints
    .map((e) =>
      [
        `/** ${e.doc} */`,
        `const ${e.local} = HttpApiEndpoint.${e.factory}(${lit(e.name)}, ${lit(e.path)})`,
        ...e.chain.map((c) => `  ${c}`),
        '  ;',
      ]
        .join('\n')
        .replace(/\n\s*;$/, ';')
    )
    .join('\n\n');

  const group = groupName(table, opts.naming);
  const adds = endpoints.map((e) => `  .add(${e.local})`).join('\n');

  const schemas: string[] = [];
  if (key) {
    // The params schema is this generator's own invention: no validation generator emits one,
    // because only a router knows that these columns arrive as path segments.
    schemas.push(
      `export const ${paramsName} = ${NS}.Struct({\n` +
        key.map((c) => `  ${objectKey(c.name)}: ${paramSchema(c)},`).join('\n') +
        `\n});`
    );
  }
  // Url params are strings too, which is why the bounds are declared on the converted side.
  schemas.push(
    `export const ${queryName} = ${NS}.Struct({\n` +
      `  limit: ${NS}.optional(${NS}.NumberFromString.pipe(${NS}.int(), ${NS}.between(1, 200))),\n` +
      `  offset: ${NS}.optional(${NS}.NumberFromString.pipe(${NS}.int(), ${NS}.nonNegative())),\n` +
      `});`
  );

  const body = [
    ...schemas,
    declared,
    `export const ${group} = HttpApiGroup.make(${lit(toCase(table.tsName, opts.naming?.procedureCase))})\n${adds}\n  .prefix(${lit(mountPath(table, opts.naming))});`,
  ].join('\n\n');

  const useShared = !!opts.validation?.useShared && !!opts.validation?.importPath;
  if (!useShared) {
    throw new Error(
      `@drzl/generator-effect-http: this generator has no schemas of its own to emit. Its endpoints ` +
        `declare the Effect Schema modules a validation generator wrote, so it needs ` +
        `validation.useShared and validation.importPath pointing at an "effect" generator's output ` +
        `directory. Add { kind: "effect" } to the config and point this one at its path.`
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
  ).filter(([, local]) => body.includes(local));
  const names = wanted
    .map(([mode, local]) => {
      const exported = schemaName(mode, table.tsName, sharedAffix);
      return exported === local ? local : `${exported} as ${local}`;
    })
    .join(', ');

  return `// Generated by @drzl/generator-effect-http
// HttpApi endpoints for table: ${table.name}
import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform';
import * as ${NS} from 'effect/Schema';
import { ${names} } from '${spec}';

${body}
`;
}

function renderBarrel(
  modules: Array<{ table: Table; filePath: string; group: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions
): string {
  const entries = modules.map((m) => ({
    group: m.group,
    rel: importSpecifier(
      './' + path.relative(ctx.out, m.filePath).replace(/\\/g, '/'),
      opts.importExtension
    ),
  }));
  const imports = entries.map((e) => `import { ${e.group} } from '${e.rel}';`).join('\n');
  const adds = entries.map((e) => `  .add(${e.group})`).join('\n');
  const reExports = entries.map((e) => `export * from '${e.rel}';`).join('\n');
  const apiName = opts.apiName ?? 'api';

  if (!entries.length) {
    return `// Generated by @drzl/generator-effect-http
// No tables in the analysis, so this API carries no groups yet.
import { HttpApi } from '@effect/platform';

export const ${apiName} = HttpApi.make(${lit(apiName)});
`;
  }

  return `// Generated by @drzl/generator-effect-http
// Every generated group, as one API.
import { HttpApi } from '@effect/platform';
${imports}

/**
 * The assembled API.
 *
 * Chained, and that is not a style choice: \`HttpApi\` accumulates its groups through the return
 * value of each \`.add\`, so a client built from this type knows about every endpoint. Written as
 * separate statements it would compile, run identically, and describe an API with no groups on it.
 */
export const ${apiName} = HttpApi.make(${lit(apiName)})
${adds};

${reExports}
`;
}
