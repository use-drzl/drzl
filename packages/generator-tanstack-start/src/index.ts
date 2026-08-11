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
 * TanStack Start server functions, one module per table.
 *
 * The smallest of DRZL's generators, because the surface it targets is the one that fits DRZL's
 * schemas without any adaptation at all. `createServerFn().validator(schema)` takes any Standard
 * Schema, and measured on 2026-08-11 against @tanstack/react-start 1.168.42 it is properly
 * variance-aware in both directions: the handler receives the schema's **output** and the caller
 * supplies its **input**, so a date column's `string -> Date` transform does real work across the
 * wire boundary and passing a `Date` from the caller is a compile error. zod, valibot and arktype
 * were each compiled through it, transform included, and all three behave the same.
 *
 * That is worth stating because the sibling case does not behave that way. TanStack Form's
 * validator constraint is *invariant*, since the Standard Schema input type sits in a property, so
 * a wider input is rejected exactly as a narrower one is and no schema shape removes the cast
 * documented on the Form example. Server functions have no such problem.
 *
 * What the generator decides that a hand-writer gets wrong is the method. A read is a GET, so it is
 * cacheable and its payload rides in the URL; a write is a POST. `createServerFn` defaults to GET,
 * so a create written without thinking about it is a mutation behind a cacheable verb.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported function names. */
  routerSuffix?: string;
  /** Casing applied to file names and identifiers. */
  procedureCase?: Case;
}

/** The barrel's filename stem. */
export const BARREL_MODULE = 'index';

export interface GenerateOptions {
  outputDir: string;
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

/**
 * How one library spells the few expressions this generator invents for itself.
 *
 * Far smaller than the other generators' dialects, and that is the point: nothing here is handed to
 * a framework that needs adapting, so the only per-library text is the key schema and the list
 * bounds, which no validation generator emits.
 */
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
  /** A reference to another schema constant used as a field value. */
  ref: (name: string) => string;
  limit: string;
  offset: string;
}

const q = (v: string) => JSON.stringify(v);

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

const BIGINT_DIGITS = String.raw`/^-?\d+$/`;

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
 * A key column's wire expression.
 *
 * The wire form and not the read form, for the reason every DRZL generator that crosses a network
 * boundary shares: what arrives is JSON, so a `Date` key is an ISO string and a `bigint` is a digit
 * string. A key is never nullable and never optional, whatever the column declaration says: a null
 * primary key matches nothing and an absent one names no row.
 */
function keyExpr(column: Column, lib: Lib): string {
  const d = LIBS[lib];
  if (column.enumValues && column.enumValues.length) return d.enum(column.enumValues);
  switch (column.tsType) {
    case 'number':
      return d.number;
    case 'string':
      return d.string;
    case 'boolean':
      return d.boolean;
    case 'Date':
      return d.dateInput;
    case 'bigint':
      return d.bigintWire;
    default:
      return d.unknown;
  }
}

function objectKey(name: string): string {
  return isIdent(name) ? name : JSON.stringify(name);
}

function keyField(column: Column, lib: Lib): string {
  const d = LIBS[lib];
  const expr = keyExpr(column, lib);
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

/** `createUsers`, with `kebab` falling back to camel since `-` is not valid in an identifier. */
function fnName(verb: string, table: Table, naming?: NamingOptions): string {
  const c = naming?.procedureCase;
  const base = toCase(`${table.tsName}${naming?.routerSuffix ?? ''}`, c === 'kebab' ? 'camel' : c);
  return `${verb}${cap(base)}`;
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

export class TanStackStartGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions) {
    const lib: Lib = (opts.validation?.library ?? 'zod') as Lib;
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

    const barrelPath = path.join(out, `${BARREL_MODULE}.ts`);
    const modules: Array<{ table: Table; filePath: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      if (filePath === barrelPath) {
        throw new Error(
          `@drzl/generator-tanstack-start: the server functions for table "${table.name}" would ` +
            `be written to ${filePath}, which is the ${BARREL_MODULE}.ts this generator also ` +
            `writes. Set naming.routerSuffix to move it out of the way.`
        );
      }
      await write(filePath, renderFunctions(table, opts, ctx, lib));
      modules.push({ table, filePath });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    await write(barrelPath, renderBarrel(modules, ctx, path, opts));
    return { files };
  }
}

export default TanStackStartGenerator;

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

interface ServerFn {
  name: string;
  method: 'GET' | 'POST';
  doc: string[];
  validator: string;
  body: string[];
}

function renderFunctions(
  table: Table,
  opts: GenerateOptions,
  ctx: RenderContext,
  lib: Lib
): string {
  const d = LIBS[lib];

  const insertName = `Insert${table.tsName}Schema`;
  const updateName = `Update${table.tsName}Schema`;
  const selectName = `Select${table.tsName}Schema`;
  const keyName = `${cap(table.tsName)}KeySchema`;
  const listName = `${cap(table.tsName)}ListInputSchema`;
  const updateInputName = `${cap(table.tsName)}UpdateInputSchema`;
  const rowType = `${cap(table.tsName)}Row`;

  const writable = !table.readOnly;
  const key = keyColumns(table);
  const fns: ServerFn[] = [];

  fns.push({
    name: fnName('list', table, opts.naming),
    // GET, so the result is cacheable and the payload rides in the URL. `createServerFn` defaults
    // to GET, which is right here and wrong for every write below.
    method: 'GET',
    doc: [`Read rows from the ${table.name} table.`],
    validator: listName,
    body: [`const rows: ${rowType}[] = [];`, 'return rows;'],
  });

  if (key) {
    fns.push({
      name: fnName('get', table, opts.naming),
      method: 'GET',
      doc: [`Read one row of the ${table.name} table, addressed by ${keyPhrase(key)}.`],
      validator: keyName,
      body: [`const row: ${rowType} | null = null;`, 'return row;'],
    });
  }

  if (writable) {
    fns.push({
      name: fnName('create', table, opts.naming),
      method: 'POST',
      doc: [
        `Insert one row into the ${table.name} table.`,
        '',
        'POST rather than the GET `createServerFn` defaults to: a mutation behind a cacheable',
        'verb is one an intermediary is entitled to replay.',
      ],
      validator: insertName,
      body: [`throw new Error('Not implemented: create ${table.tsName}.');`],
    });
  }

  if (writable && key) {
    fns.push({
      name: fnName('update', table, opts.naming),
      method: 'POST',
      doc: [
        `Change one row of the ${table.name} table.`,
        '',
        '`where` addresses the row and `data` carries the columns to write. Two properties rather',
        'than one flat object, because the key would otherwise appear on both sides with no way to',
        'tell the row being addressed from the value being set.',
      ],
      validator: updateInputName,
      body: [`throw new Error('Not implemented: update ${table.tsName}.');`],
    });

    fns.push({
      name: fnName('delete', table, opts.naming),
      method: 'POST',
      doc: [`Remove one row from the ${table.name} table, addressed by ${keyPhrase(key)}.`],
      validator: keyName,
      body: [`throw new Error('Not implemented: delete ${table.tsName}.');`],
    });
  }

  const rendered = fns
    .map((f) => {
      // The handler argument is named for whether the body reads it: a stub whose only statement is
      // `throw` never touches it, and `noUnusedParameters` exempts a leading underscore.
      const arg = f.body.some((line) => /\bdata\b/.test(line)) ? '{ data }' : '_ctx';
      return [
        '/**',
        ...f.doc.map((l) => (l ? ` * ${l}` : ' *')),
        ' */',
        `export const ${f.name} = createServerFn({ method: '${f.method}' })`,
        `  .validator(${f.validator})`,
        `  .handler(async (${arg}) => {`,
        ...f.body.map((line) => `    ${line}`),
        `  });`,
      ].join('\n');
    })
    .join('\n\n');

  const useShared = !!opts.validation?.useShared && !!opts.validation?.importPath;
  const declared: string[] = [];

  if (key) {
    // The key schema is always declared, never imported: no validation generator emits one, because
    // only a caller addressing a row needs it.
    declared.push(
      `export const ${keyName} = ${d.objectInline(
        key.map((c) => keyField(c, lib)).join(', ')
      )};`
    );
  }

  // Bounded rather than open, because a page size in a URL is a value anybody can set.
  declared.push(
    `export const ${listName} = ${d.objectInline(`limit: ${d.limit}, offset: ${d.offset}`)};`
  );

  if (writable && key) {
    declared.push(
      `export const ${updateInputName} = ${d.objectInline(
        `where: ${d.ref(keyName)}, data: ${d.ref(updateName)}`
      )};`
    );
  }

  const decided = [...declared, rendered].join('\n\n');

  const imports: string[] = [`import { createServerFn } from '@tanstack/react-start';`];
  const wanted: Array<['insert' | 'update' | 'select', string]> = (
    [
      ['insert', insertName],
      ['update', updateName],
      ['select', selectName],
    ] as Array<['insert' | 'update' | 'select', string]>
  ).filter(([, local]) => decided.includes(local) || local === selectName);

  if (!useShared) {
    throw new Error(
      `@drzl/generator-tanstack-start: this generator has no schemas of its own to emit. Its ` +
        `server functions validate with the schemas a validation generator wrote, so it needs ` +
        `validation.useShared and validation.importPath pointing at that generator's output ` +
        `directory. Add a "zod", "valibot" or "arktype" generator to the config and point this ` +
        `one at its path.`
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
  const names = wanted
    .map(([mode, local]) => {
      const exported = schemaName(mode, table.tsName, sharedAffix);
      return exported === local ? local : `${exported} as ${local}`;
    })
    .join(', ');
  imports.push(`import { ${names} } from '${spec}';`);

  // The row type the read stubs annotate themselves with, so filling one in is a compile error
  // until the shape is right. Inferred from the select schema the validation generator already
  // exports rather than from a schema this generator would have to invent.
  const inferImport =
    lib === 'zod'
      ? `import type { z } from 'zod';`
      : lib === 'valibot'
        ? `import type * as v from 'valibot';`
        : '';
  const rowAlias =
    lib === 'zod'
      ? `export type ${rowType} = z.output<typeof ${selectName}>;`
      : lib === 'valibot'
        ? `export type ${rowType} = v.InferOutput<typeof ${selectName}>;`
        : `export type ${rowType} = typeof ${selectName}.infer;`;

  const body = [rowAlias, decided].join('\n\n');
  if (inferImport && !LIB_USAGE[lib].test(decided)) imports.push(inferImport);
  else if (LIB_USAGE[lib].test(decided)) imports.unshift(LIB_IMPORTS[lib]);

  return `// Generated by @drzl/generator-tanstack-start
// Server functions for table: ${table.name}
${imports.join('\n')}

${body}
`;
}

function renderBarrel(
  modules: Array<{ table: Table; filePath: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions
): string {
  const specs = modules.map((m) =>
    importSpecifier(
      './' + path.relative(ctx.out, m.filePath).replace(/\\/g, '/'),
      opts.importExtension
    )
  );
  const reExports = specs.map((s) => `export * from '${s}';`).join('\n');
  return `// Generated by @drzl/generator-tanstack-start
// Every generated server function.
${reExports || '// No tables in the analysis, so there is nothing to re-export.'}
`;
}
