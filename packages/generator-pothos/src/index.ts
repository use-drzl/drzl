import { fileWriter, type FileSink } from '@drzl/validation-core';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import type { ImportExtension } from '@drzl/validation-core';
import { formatCode, importSpecifier } from '@drzl/validation-core';

/**
 * A Pothos schema builder, one object type per table.
 *
 * DRZL already emits GraphQL SDL. SDL is a string: it describes a schema and cannot be extended, so
 * a resolver written against it is checked by nothing. A Pothos builder is code, and the whole
 * reason to emit it instead is that the row type is checked. `t.exposeString('emial')` is a compile
 * error here and silently returns undefined from a hand-written resolver.
 *
 * That advantage only exists in one of Pothos's two shapes, so the choice is not cosmetic:
 *
 *     builder.objectRef('Users').implement({ fields: ... })   runtime ref, nothing is checked
 *     builder.objectType('Users', { fields: ... })            checked against SchemaBuilder<{ Objects }>
 *
 * The second is what this emits, with a `Row` interface per table registered in the builder's
 * `Objects` map. Emitting the first would give up the only thing this generator has that the SDL
 * generator does not.
 *
 * Field nullability depends on which of those two shapes is used, and that cost a wrong turn here.
 * Measured against `@pothos/core@4.13.1`: a builder with **no type parameter** runs in v3
 * compatibility and defaults every field to *nullable*, so a bare `t.exposeString('email')` prints
 * `String` and `defaultFieldNullability: false` is what gets `String!`. A builder with a v4 generic,
 * which is what this emits, already defaults to non-null, and that same option types as `never`
 * there, because it exists only to opt *into* nullable.
 *
 * The first measurement was taken on the ref shape and so did not describe the emission at all. No
 * option is set now, every field is non-null unless marked, and a test asserts both directions
 * against the schema this generator actually produces.
 *
 * The scalar decisions are taken from `@drzl/generator-graphql` rather than reinvented, because the
 * same column described two ways by two DRZL generators is worse than either description. In
 * particular `Int` is used only where declared bounds prove the value fits 32 bits, since graphql-js
 * refuses 2^31 on every coercion path and an unbounded integer column must not fail reads.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported identifiers. */
  routerSuffix?: string;
  /** Casing applied to file names and identifiers. */
  procedureCase?: Case;
}

/** The barrel's filename stem, which is also where the builder itself is declared. */
export const BUILDER_MODULE = 'builder';
/** The module that assembles the schema. */
export const SCHEMA_MODULE = 'index';

export interface GenerateOptions {
  outputDir: string;
  naming?: NamingOptions;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /** How every relative specifier this generator invents spells its extension. Defaults to `'js'`. */
  importExtension?: ImportExtension;
  /** Where the generated files go, when that is not the filesystem. */
  fileSink?: FileSink;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
const q = (v: string) => JSON.stringify(v);

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

function baseName(table: Table, naming?: NamingOptions): string {
  const c = naming?.procedureCase;
  return toCase(`${table.tsName}${naming?.routerSuffix ?? ''}`, c === 'kebab' ? 'camel' : c);
}

/** The GraphQL type name, which is also the key in the builder's `Objects` map. */
function typeName(table: Table, naming?: NamingOptions): string {
  return cap(baseName(table, naming));
}

/** The TypeScript interface the object type is checked against. */
function rowTypeName(table: Table, naming?: NamingOptions): string {
  return `${typeName(table, naming)}Row`;
}

const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;

/** Whether this column is a whole number, matching how the SDL generator decides. */
function isIntegerColumn(c: Column): boolean {
  if (typeof c.integer === 'boolean') return c.integer;
  // Pre-1.7 analyses have no flag, and the old inference was "carries both bounds".
  return c.min !== undefined && c.max !== undefined;
}

/**
 * Whether declared bounds prove this integer fits GraphQL's 32 bit `Int`.
 *
 * Taken from `@drzl/generator-graphql`, which measured it: graphql-js refuses 2^31 on all three
 * coercion paths, so an unbounded integer column typed `Int` would fail reads of values the database
 * holds. `Float` is the honest answer where nothing proves the width.
 */
function fitsInt32(c: Column): boolean {
  if (c.min === undefined || c.max === undefined) return false;
  try {
    return BigInt(c.min) >= INT32_MIN && BigInt(c.max) <= INT32_MAX;
  } catch {
    return false;
  }
}

/** A GraphQL scalar this generator has to register on the builder before using. */
type CustomScalar = 'DateTime' | 'BigInt' | 'JSON';

interface Mapped {
  /** The GraphQL type name. */
  graphql: string;
  /** The TypeScript type the row interface declares. */
  ts: string;
  /** The scalar to register, where the type is not one GraphQL defines. */
  scalar?: CustomScalar;
  /** The `t.expose*` helper, where one exists for this type. */
  expose?: 'exposeInt' | 'exposeFloat' | 'exposeString' | 'exposeBoolean' | 'exposeID';
}

/**
 * One column's GraphQL and TypeScript types.
 *
 * The decisions match `@drzl/generator-graphql` exactly, and deliberately: the same column described
 * two ways by two DRZL generators is worse than either description on its own.
 */
function mapColumn(c: Column): Mapped {
  if (c.enumValues && c.enumValues.length) {
    // An enum column is a string on the wire here rather than a GraphQL enum, because a GraphQL
    // enum member must be a valid name and a database enum value need not be: `'in progress'` and
    // `'2xl'` are both legal in Postgres and neither is a legal GraphQL enum value.
    return { graphql: 'String', ts: c.enumValues.map(q).join(' | '), expose: 'exposeString' };
  }
  if (c.dbType === 'VECTOR') return { graphql: '[Float!]', ts: 'number[]' };
  switch (c.tsType) {
    case 'number':
      return isIntegerColumn(c) && fitsInt32(c)
        ? { graphql: 'Int', ts: 'number', expose: 'exposeInt' }
        : { graphql: 'Float', ts: 'number', expose: 'exposeFloat' };
    case 'string':
      return c.format === 'uuid'
        ? { graphql: 'ID', ts: 'string', expose: 'exposeID' }
        : { graphql: 'String', ts: 'string', expose: 'exposeString' };
    case 'boolean':
      return { graphql: 'Boolean', ts: 'boolean', expose: 'exposeBoolean' };
    case 'Date':
      return { graphql: 'DateTime', ts: 'Date', scalar: 'DateTime' };
    case 'bigint':
      return { graphql: 'BigInt', ts: 'bigint', scalar: 'BigInt' };
    default:
      return { graphql: 'JSON', ts: 'unknown', scalar: 'JSON' };
  }
}

/** Every custom scalar the whole analysis needs, so the builder registers each exactly once. */
function scalarsUsed(tables: Table[]): CustomScalar[] {
  const seen = new Set<CustomScalar>();
  for (const t of tables) {
    for (const c of t.columns) {
      const s = mapColumn(c).scalar;
      if (s) seen.add(s);
    }
  }
  return (['DateTime', 'BigInt', 'JSON'] as CustomScalar[]).filter((s) => seen.has(s));
}

/**
 * The scalar implementations, which are the generator's own rather than a dependency.
 *
 * `graphql-scalars` would supply these and is a package a consumer does not otherwise need for
 * three definitions this short. Each one is deliberately strict on the way in: a scalar that
 * coerces silently is how a `DateTime` field ends up holding the string `"not a date"`.
 */
const SCALAR_SOURCE: Record<CustomScalar, string> = {
  DateTime: `export const DateTimeScalar = new GraphQLScalarType<Date, string>({
  name: 'DateTime',
  description: 'An instant, as an ISO 8601 string in UTC.',
  serialize(value) {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TypeError('DateTime.serialize: expected a valid Date');
    }
    return value.toISOString();
  },
  parseValue(value) {
    if (typeof value !== 'string') throw new TypeError('DateTime: expected an ISO 8601 string');
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new TypeError('DateTime: unparseable instant');
    return parsed;
  },
});`,
  BigInt: `export const BigIntScalar = new GraphQLScalarType<bigint, string>({
  name: 'BigInt',
  description: 'An integer of arbitrary size, as its decimal digits.',
  // A string on the wire, not a number: JSON.stringify(1n) throws, and a number loses precision
  // past 2^53. The same choice the NestJS and oRPC generators pin with tests.
  serialize(value) {
    if (typeof value !== 'bigint') throw new TypeError('BigInt.serialize: expected a bigint');
    return value.toString();
  },
  parseValue(value) {
    if (typeof value !== 'string' || !/^-?\\d+$/.test(value)) {
      throw new TypeError('BigInt: expected a string of decimal digits');
    }
    return globalThis.BigInt(value);
  },
});`,
  JSON: `export const JSONScalar = new GraphQLScalarType<unknown, unknown>({
  name: 'JSON',
  description: 'Any JSON value, passed through unchanged.',
  serialize: (value) => value,
  parseValue: (value) => value,
});`,
};

interface RenderContext {
  out: string;
}

export class PothosGenerator {
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

    const tables = this.analysis.tables;
    const builderPath = path.join(out, `${BUILDER_MODULE}.ts`);
    const schemaPath = path.join(out, `${SCHEMA_MODULE}.ts`);

    await write(builderPath, renderBuilder(tables, opts));

    const modules: Array<{ table: Table; filePath: string }> = [];
    let index = 0;
    for (const table of tables) {
      const filePath = path.join(
        out,
        `${toCase(`${table.tsName}${opts.naming?.routerSuffix ?? ''}`, opts.naming?.procedureCase)}.ts`
      );
      if (filePath === builderPath || filePath === schemaPath) {
        throw new Error(
          `@drzl/generator-pothos: the object type for table "${table.name}" would be written to ` +
            `${filePath}, which is a module this generator also writes. Set naming.routerSuffix ` +
            `to move it out of the way.`
        );
      }
      await write(filePath, renderObjectType(table, opts));
      modules.push({ table, filePath });
      index++;
      opts.onProgress?.({ index, total: tables.length, table: table.name, filePath });
    }

    await write(schemaPath, renderSchema(modules, ctx, path, opts));
    return { files };
  }
}

export default PothosGenerator;

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
 * The builder, and every row interface it is parameterised by.
 *
 * One module rather than one per table, because `SchemaBuilder<{ Objects: ... }>` names every type
 * in a single generic: split across files, each object module would import the builder and the
 * builder would import each module's row type, which is a cycle.
 */
function renderBuilder(tables: Table[], opts: GenerateOptions): string {
  const rows = tables.map((t) => {
    const fields = t.columns
      .map((c) => {
        const m = mapColumn(c);
        return `  ${objectKey(c.name)}: ${c.nullable ? `${m.ts} | null` : m.ts};`;
      })
      .join('\n');
    return `export interface ${rowTypeName(t, opts.naming)} {\n${fields}\n}`;
  });

  const objects = tables
    .map((t) => `    ${typeName(t, opts.naming)}: ${rowTypeName(t, opts.naming)};`)
    .join('\n');

  const scalars = scalarsUsed(tables);
  const scalarDefs = scalars.map((s) => SCALAR_SOURCE[s]).join('\n\n');
  const scalarEntries = scalars
    .map((s) => {
      const io =
        s === 'DateTime'
          ? '{ Input: Date; Output: Date }'
          : s === 'BigInt'
            ? '{ Input: bigint; Output: bigint }'
            : '{ Input: unknown; Output: unknown }';
      return `    ${s}: ${io};`;
    })
    .join('\n');
  const scalarBlock = scalars.length ? `  Scalars: {\n${scalarEntries}\n  };\n` : '';
  const registrations = scalars
    .map((s) => `builder.addScalarType('${s}', ${s}Scalar);`)
    .join('\n');

  const graphqlImport = scalars.length
    ? "import { GraphQLScalarType } from 'graphql';\n"
    : '';

  return `// Generated by @drzl/generator-pothos
// The builder, and the row type of every table it knows about.
import SchemaBuilder from '@pothos/core';
${graphqlImport}
${rows.join('\n\n')}

${scalarDefs ? `${scalarDefs}\n` : ''}
/**
 * The schema builder.
 *
 * No \`defaultFieldNullability\` here, and that is worth stating because the obvious reading says
 * there should be. A builder constructed with no type parameter runs in v3 compatibility, where
 * fields default to *nullable* and that option is what makes a NOT NULL column print \`String!\`. A
 * builder with a v4 generic, which is what this is, already defaults to non-null, and the option
 * types as \`never\` there: it exists only to opt *into* nullable.
 *
 * So every field below is non-null unless it says otherwise, and the nullable columns say so.
 */
export const builder = new SchemaBuilder<{
${scalarBlock}  Objects: {
${objects || '    // No tables in the analysis.'}
  };
}>({});
${registrations ? `\n${registrations}\n` : ''}`;
}

/** One table's object type, and the query fields that read it. */
function renderObjectType(table: Table, opts: GenerateOptions): string {
  const name = typeName(table, opts.naming);
  const rowType = rowTypeName(table, opts.naming);
  const spec = importSpecifier(`./${BUILDER_MODULE}.ts`, opts.importExtension);

  const fields = table.columns
    .map((c) => {
      const m = mapColumn(c);
      // `nullable` is stated on every field, never left to the builder's default. The default is
      // nullable at runtime, and `defaultFieldNullability: false` is typed `never` under a v4
      // generic, so the option that would fix it centrally cannot be written. Saying it per field
      // is what compiles and runs, and it also lets a reader see a column's nullability without
      // knowing anything about the builder.
      const nullable = `{ nullable: ${c.nullable} }`;
      if (m.expose) return `    ${objectKey(c.name)}: t.${m.expose}(${q(c.name)}, ${nullable}),`;
      // No `expose*` helper for a custom scalar or a list, so the type is named.
      const type = m.graphql.startsWith('[')
        ? `[${q(m.graphql.slice(1, -2))}]`
        : q(m.graphql);
      return `    ${objectKey(c.name)}: t.expose(${q(c.name)}, { type: ${type}, nullable: ${c.nullable} }),`;
    })
    .join('\n');

  return `// Generated by @drzl/generator-pothos
// Object type for table: ${table.name}
import { builder, type ${rowType} } from '${spec}';

builder.objectType(${q(name)}, {
  description: ${q(`A row of the ${table.name} table.`)},
  fields: (t) => ({
${fields}
  }),
});

/**
 * A resolver's return type, exported so a hand-written one can be checked against it.
 *
 * This is the whole reason to emit a builder rather than the SDL DRZL already writes: a resolver
 * returning the wrong shape is a compile error here, and silently returns undefined there.
 */
export type { ${rowType} };
`;
}

/** The module that pulls every object type in and builds the schema. */
function renderSchema(
  modules: Array<{ table: Table; filePath: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions
): string {
  const entries = modules.map((m) => ({
    table: m.table,
    name: typeName(m.table, opts.naming),
    field: toCase(m.table.tsName, opts.naming?.procedureCase),
    rel: importSpecifier(
      './' + path.relative(ctx.out, m.filePath).replace(/\\/g, '/'),
      opts.importExtension
    ),
  }));

  const imports = entries.map((e) => `import '${e.rel}';`).join('\n');
  const reExports = entries.map((e) => `export * from '${e.rel}';`).join('\n');
  const builderSpec = importSpecifier(`./${BUILDER_MODULE}.ts`, opts.importExtension);

  const queryFields = entries
    .map(
      (e) =>
        `    ${objectKey(e.field)}: t.field({\n` +
        `      type: [${q(e.name)}],\n` +
        // Same rule as the object fields: stated, never left to a default that is nullable.
        `      nullable: false,\n` +
        `      resolve: () => {\n` +
        `        throw new Error('Not implemented: resolve ${e.table.name}. Return the rows.');\n` +
        `      },\n` +
        `    }),`
    )
    .join('\n');

  return `// Generated by @drzl/generator-pothos
// Every object type, and the schema they assemble into.
//
// The query fields throw rather than returning an empty list, so an unimplemented resolver is a
// failed request rather than a silently empty one. A caller reading an empty array cannot tell the
// difference between "no rows" and "nobody wrote this yet".
import { builder } from '${builderSpec}';
${imports}

builder.queryType({
  fields: (t) => ({
${queryFields || '    // No tables in the analysis.'}
  }),
});

export const schema = builder.toSchema();
export { builder };

${reExports || '// No tables in the analysis, so there is nothing to re-export.'}
`;
}
