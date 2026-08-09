import { fileWriter, type FileSink } from '@drzl/validation-core';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import type { ImportExtension } from '@drzl/validation-core';
import {
  formatCode,
  importSpecifier,
  insertColumns,
  isIntegerColumn,
  selectColumns,
  updateColumns,
} from '@drzl/validation-core';

/*
 * A GraphQL schema from the same analysis: SDL `typeDefs` per table, resolver stubs that
 * throw, enum value maps and dependency-free scalar configs, joined by a barrel into one
 * `{ typeDefs, resolvers }` pair for makeExecutableSchema, graphql-yoga or Apollo Server.
 * Plain `buildSchema(typeDefs)` accepts the SDL too, but takes no resolvers.
 *
 * SDL text and plain objects rather than GraphQLSchema instances, settled from the registry
 * (2026-08-08): graphql@latest is 17.0.2 while Apollo Server pins ^16.11.0 and graphql-yoga
 * ^15.2 || ^16, so emitted code importing graphql would pick a side of that split and risk
 * graphql-js's "another module or realm" error. Strings and plain objects have no side to
 * pick: the emitted modules import NOTHING at runtime and there is no graphql peer at all.
 * The scalar configs name every hook twice, because graphql 17 renamed them and a
 * legacy-named config there measures broken quietly (variables skip parseValue; a skipped
 * serialize lets a raw bigint escape); dual naming measures correct on 16.14.2 and 17.0.2.
 *
 * The decisions, each measured at execution (the docs page and changeset carry the grids):
 * Int only where declared bounds prove 32 bits, because graphql-js refuses 2^31 on all three
 * coercion paths and an unbounded integer column must not fail reads. bigint is a BigInt
 * scalar crossing as digit strings (JSON numbers were already rounded by JSON.parse; inline
 * integer literals are lossless, the AST carries raw digits). Date is a strict-ISO DateTime
 * scalar handing the resolver a real Date. numeric-as-string stays String; uuid is ID;
 * json/jsonb and untypeable columns are a passthrough JSON scalar. Arrays are lists with
 * NULLABLE elements, because Postgres arrays admit NULL elements and a null under [T!] nulls
 * the whole field with an error. Enum members keep their database spelling where it is a
 * valid GraphQL name and are renamed otherwise (in-progress is an SDL syntax error, 2fa a
 * malformed number, "with space" silently parses as TWO members), with a value map for
 * exactly the renamed members so both directions execute correctly; two values renaming onto
 * one name fall back to String with a note, and a column name that is no GraphQL Name is
 * exposed renamed with an emitted field resolver mapping it back to the row property.
 *
 * Inputs lean on GraphQL's native absent-vs-null distinction: create inputs mark
 * required-no-default columns Type!, update inputs are all-optional with the primary key
 * excluded via the shared updateColumns. The DTO generators' required-but-nullable presence
 * rule is inexpressible in GraphQL, documented rather than approximated. The barrel owns
 * Query and Mutation (a schema without a Query type fails assertValidSchema); keyless tables
 * get a list field and create only, composite keys become multi-argument byId fields, and a
 * read-only table gets no mutations and no input types.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /**
   * Appended to `tsName` for the file name: `'Gql'` with `procedureCase: 'kebab'` writes
   * `users-gql.ts`. Export names are fixed per module and do not take the suffix.
   */
  routerSuffix?: string;
  /** Casing applied to file names. */
  procedureCase?: Case;
}

/** The barrel's filename stem. */
export const APP_MODULE = 'index';

/** The scalar-config module's filename stem. */
export const SCALARS_MODULE = 'scalars';

export interface GenerateOptions {
  outputDir: string;
  naming?: NamingOptions;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /**
   * How every relative specifier this generator invents spells its extension: the barrel's
   * imports and re-exports. Defaults to `'js'`, the only form that resolves under every
   * `moduleResolution` without a compiler flag.
   */
  importExtension?: ImportExtension;
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

const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** Forbidden as enum member names by the GraphQL grammar (measured: a parse error in SDL). */
const RESERVED_ENUM_VALUES = new Set(['true', 'false', 'null']);

const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
const q = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** A string usable as a GraphQL Name, derived from any identifier-ish input. */
function gqlIdent(s: string): string {
  const cleaned = s.replace(/[^_0-9A-Za-z]+/g, '_');
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Escape a string for inclusion inside an emitted template literal. */
function tpl(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * The columns that address one row, or `null` when nothing does. A table with no primary key
 * genuinely cannot be addressed, so it gets no byId field and no update or delete mutation.
 */
function keyColumns(table: Table): Column[] | null {
  const names = table.primaryKey?.columns ?? [];
  if (!names.length) return null;
  const cols = names.map((n) => table.columns.find((c) => c.name === n));
  if (cols.some((c) => !c)) return null;
  return cols as Column[];
}

/** Whether the declared bounds prove this integer column fits GraphQL's 32-bit Int. */
function fitsInt32(c: Column): boolean {
  if (c.min === undefined || c.max === undefined) return false;
  try {
    return BigInt(c.min) >= INT32_MIN && BigInt(c.max) <= INT32_MAX;
  } catch {
    // A bound with a fractional or exponent spelling is not an integer bound at all.
    return false;
  }
}

interface EnumMember {
  /** The GraphQL member name. */
  name: string;
  /** The database value. */
  value: string;
  /** Whether the two differ, which is what puts the member into the value map. */
  renamed: boolean;
}

interface EnumPlan {
  typeName: string;
  members: EnumMember[];
}

/**
 * The enum policy: verbatim where the value is already a valid member name, renamed where it
 * is not, and `null` (String fallback) where two values land on one name and no value map
 * could tell them apart.
 */
function planEnum(typeName: string, values: string[]): EnumPlan | null {
  const members: EnumMember[] = values.map((value) => {
    const verbatimOk =
      GRAPHQL_NAME.test(value) && !RESERVED_ENUM_VALUES.has(value) && !value.startsWith('__');
    if (verbatimOk) return { name: value, value, renamed: false };
    let name = gqlIdent(value.toUpperCase());
    name = name.replace(/^_+/, '_');
    if (!GRAPHQL_NAME.test(name) || RESERVED_ENUM_VALUES.has(name) || name.startsWith('__')) {
      return { name: '', value, renamed: true };
    }
    return { name, value, renamed: true };
  });
  if (members.some((m) => !m.name)) return null;
  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m.name)) return null;
    seen.add(m.name);
  }
  return { typeName, members };
}

interface ColumnPlan {
  column: Column;
  /** The GraphQL field name, `gqlIdent`-mangled where the column name is not a Name. */
  field: string;
  /** Whether `field` differs from the column name, which needs an output field resolver. */
  renamed: boolean;
  /** The SDL type without the outer `!`. */
  sdl: string;
  /** The TypeScript type of the value a resolver RETURNS for this column. */
  rowTs: string;
  /** The TypeScript type of the value a resolver RECEIVES for this column. */
  inputTs: string;
  /** Custom scalars this column's type reaches for. */
  scalars: string[];
  enumPlan?: EnumPlan;
  /** A note the module carries about this column's mapping. */
  note?: string;
}

type BasePlan = Pick<ColumnPlan, 'sdl' | 'rowTs' | 'inputTs' | 'scalars'> &
  Partial<Pick<ColumnPlan, 'enumPlan' | 'note'>>;

/** One mapping row: SDL type, resolver-facing TS types, and the scalars it reaches for. */
function mapped(sdl: string, rowTs: string, inputTs = rowTs, scalars: string[] = []): BasePlan {
  return { sdl, rowTs, inputTs, scalars };
}

function planColumn(table: Table, c: Column): ColumnPlan {
  const field = GRAPHQL_NAME.test(c.name) ? c.name : gqlIdent(c.name);
  const base: BasePlan = (() => {
    if (c.enumValues && c.enumValues.length) {
      const typeName = `${cap(gqlIdent(table.tsName))}${cap(gqlIdent(c.name))}Enum`;
      const plan = planEnum(typeName, c.enumValues);
      if (!plan) {
        return {
          ...mapped('String', 'string'),
          note:
            `Column "${c.name}": the enum values ${c.enumValues.join(', ')} cannot all be ` +
            `spelled as distinct GraphQL enum members, so the column is exposed as String ` +
            `carrying the database values verbatim.`,
        };
      }
      const union = c.enumValues.map(q).join(' | ');
      return { ...mapped(plan.typeName, union), enumPlan: plan };
    }
    switch (c.shape?.kind) {
      case 'tuple':
        return mapped('[Float!]', 'number[]');
      case 'numberObject':
        return mapped('JSON', 'unknown', 'unknown', ['JSON']);
      case 'buffer':
        return {
          ...mapped('JSON', 'unknown', 'unknown', ['JSON']),
          note:
            `Column "${c.name}" is binary; GraphQL has no binary type, so it rides the JSON ` +
            `scalar and your resolver picks an encoding.`,
        };
      case 'json':
        return mapped('JSON', 'unknown', 'unknown', ['JSON']);
      case 'bitstring':
      case 'byteString':
        return mapped('String', 'string');
      default:
        break;
    }
    if (c.dbType === 'VECTOR') return mapped('[Float!]', 'number[]');
    switch (c.tsType) {
      case 'number':
        return mapped(isIntegerColumn(c) && fitsInt32(c) ? 'Int' : 'Float', 'number');
      case 'string':
        return mapped(c.format === 'uuid' ? 'ID' : 'String', 'string');
      case 'boolean':
        return mapped('Boolean', 'boolean');
      case 'Date':
        return mapped('DateTime', 'Date', 'Date', ['DateTime']);
      case 'bigint':
        return mapped('BigInt', 'string | bigint', 'string', ['BigInt']);
      default:
        return {
          ...mapped('JSON', 'unknown', 'unknown', ['JSON']),
          note:
            `No GraphQL type for column "${c.name}": DRZL could not derive one from the ` +
            `schema, so it is exposed through the JSON scalar and accepts any value there.`,
        };
    }
  })();

  let { sdl, rowTs, inputTs } = base;
  const dims = c.arrayDimensions ?? 0;
  for (let i = 0; i < dims; i++) {
    // Elements stay nullable: Postgres arrays admit NULL elements, and a null under [T!]
    // nulls the whole field with an error at serialize (measured).
    sdl = `[${sdl}]`;
    rowTs = `(${rowTs} | null)[]`;
    inputTs = `(${inputTs} | null)[]`;
  }

  return {
    column: c,
    field,
    renamed: field !== c.name,
    sdl,
    rowTs,
    inputTs,
    scalars: base.scalars,
    enumPlan: base.enumPlan,
    note: base.note,
  };
}

interface Operation {
  /** Where the field lives. */
  parent: 'Query' | 'Mutation';
  /** The field name, e.g. `usersById`. */
  name: string;
  /** SDL argument list, e.g. `id: Int!, input: UpdateUsersInput!`, empty for none. */
  argsSdl: string;
  /** SDL result type, e.g. `[Users!]!`. */
  resultSdl: string;
  /** TypeScript type of the args object the stub receives. */
  argsTs: string;
  /** TypeScript return type of the stub. */
  resultTs: string;
}

interface TablePlan {
  table: Table;
  typeName: string;
  createInput: string;
  updateInput: string;
  select: ColumnPlan[];
  insert: ColumnPlan[];
  update: ColumnPlan[];
  key: ColumnPlan[] | null;
  writable: boolean;
  hasCreate: boolean;
  hasUpdate: boolean;
  ops: Operation[];
  scalars: Set<string>;
  enums: EnumPlan[];
  notes: string[];
  /** Select columns whose GraphQL field is a rename, needing an output field resolver. */
  renamedSelect: ColumnPlan[];
}

function planTable(table: Table): TablePlan {
  const typeName = cap(gqlIdent(table.tsName));
  const fieldBase = gqlIdent(table.tsName);
  const select = selectColumns(table).map((c) => planColumn(table, c));
  const writable = !table.readOnly;
  const insert = writable ? insertColumns(table).map((c) => planColumn(table, c)) : [];
  const update = writable ? updateColumns(table).map((c) => planColumn(table, c)) : [];
  const keyCols = keyColumns(table);
  const key = keyCols ? keyCols.map((c) => planColumn(table, c)) : null;

  const scalars = new Set<string>();
  const enums: EnumPlan[] = [];
  const notes: string[] = [];
  for (const p of select) {
    for (const s of p.scalars) scalars.add(s);
    if (p.enumPlan) enums.push(p.enumPlan);
    if (p.note) notes.push(p.note);
  }

  const createInput = `Create${typeName}Input`;
  const updateInput = `Update${typeName}Input`;
  const hasCreate = writable && insert.length > 0;
  const hasUpdate = writable && key !== null && update.length > 0;

  const keyArgsSdl = key ? key.map((p) => `${p.field}: ${p.sdl}!`).join(', ') : '';
  const keyArgsTs = key ? key.map((p) => `${p.field}: ${p.inputTs}`).join('; ') : '';

  const ops: Operation[] = [];
  ops.push({
    parent: 'Query',
    name: fieldBase,
    argsSdl: '',
    resultSdl: `[${typeName}!]!`,
    argsTs: 'Record<string, never>',
    resultTs: `${typeName}[]`,
  });
  if (key) {
    ops.push({
      parent: 'Query',
      name: `${fieldBase}ById`,
      argsSdl: keyArgsSdl,
      resultSdl: typeName,
      argsTs: `{ ${keyArgsTs} }`,
      resultTs: `${typeName} | null`,
    });
  }
  if (hasCreate) {
    ops.push({
      parent: 'Mutation',
      name: `create${typeName}`,
      argsSdl: `input: ${createInput}!`,
      resultSdl: `${typeName}!`,
      argsTs: `{ input: ${createInput} }`,
      resultTs: typeName,
    });
  }
  if (hasUpdate) {
    ops.push({
      parent: 'Mutation',
      name: `update${typeName}`,
      argsSdl: `${keyArgsSdl}, input: ${updateInput}!`,
      resultSdl: `${typeName}!`,
      argsTs: `{ ${keyArgsTs}; input: ${updateInput} }`,
      resultTs: typeName,
    });
  }
  if (writable && key) {
    ops.push({
      parent: 'Mutation',
      name: `delete${typeName}`,
      argsSdl: keyArgsSdl,
      resultSdl: 'Boolean!',
      argsTs: `{ ${keyArgsTs} }`,
      resultTs: 'boolean',
    });
  }

  const renamedSelect = select.filter((p) => p.renamed);
  for (const p of renamedSelect) {
    notes.push(
      `Column "${p.column.name}" is not a valid GraphQL field name, so it is exposed as ` +
        `"${p.field}": output is mapped back by the emitted field resolver, and on inputs ` +
        `the value arrives under "${p.field}" for your resolver to write back.`
    );
  }

  return {
    table,
    typeName,
    createInput,
    updateInput,
    select,
    insert,
    update,
    key,
    writable,
    hasCreate,
    hasUpdate,
    ops,
    scalars,
    enums,
    notes,
    renamedSelect,
  };
}

function renderEnumSdl(plan: EnumPlan): string {
  const lines: string[] = [`enum ${plan.typeName} {`];
  for (const m of plan.members) {
    if (m.renamed) lines.push(`  ${JSON.stringify(`Database value: ${m.value}`)}`);
    lines.push(`  ${m.name}`);
  }
  lines.push('}');
  return lines.join('\n');
}

function renderTypeSdl(plan: TablePlan): string {
  const parts: string[] = [];
  for (const e of plan.enums) parts.push(renderEnumSdl(e));
  parts.push(
    [
      `type ${plan.typeName} {`,
      ...plan.select.map((p) => `  ${p.field}: ${p.sdl}${p.column.nullable ? '' : '!'}`),
      '}',
    ].join('\n')
  );
  if (plan.hasCreate) {
    parts.push(
      [
        `input ${plan.createInput} {`,
        ...plan.insert.map((p) => {
          const required = !p.column.nullable && !p.column.hasDefault;
          return `  ${p.field}: ${p.sdl}${required ? '!' : ''}`;
        }),
        '}',
      ].join('\n')
    );
  }
  if (plan.hasUpdate) {
    parts.push(
      [
        `input ${plan.updateInput} {`,
        ...plan.update.map((p) => `  ${p.field}: ${p.sdl}`),
        '}',
      ].join('\n')
    );
  }
  return parts.join('\n\n');
}

/** One interface field line, quoting the key where the column name is not an identifier. */
function rowField(p: ColumnPlan): string {
  const key = isIdent(p.column.name) ? p.column.name : q(p.column.name);
  return `  ${key}: ${p.rowTs}${p.column.nullable ? ' | null' : ''};`;
}

function inputField(p: ColumnPlan, mode: 'insert' | 'update'): string {
  const required = mode === 'insert' && !p.column.nullable && !p.column.hasDefault;
  // GraphQL nullable input fields admit explicit null whatever the column says, so every
  // optional field is typed `| null` rather than pretending the runtime refuses it.
  return required ? `  ${p.field}: ${p.inputTs};` : `  ${p.field}?: ${p.inputTs} | null;`;
}

const stubBody = (parent: string, name: string) =>
  `throw new Error('Not implemented: ${parent}.${name}. Replace this stub with your data layer.');`;

function renderResolvers(plan: TablePlan): string {
  const lines: string[] = ['{'];
  const byParent = (parent: 'Query' | 'Mutation') => plan.ops.filter((o) => o.parent === parent);

  const renderOps = (parent: 'Query' | 'Mutation') => {
    lines.push(`  ${parent}: {`);
    for (const op of byParent(parent)) {
      lines.push(
        `    ${op.name}: (_parent: unknown, _args: ${op.argsTs}): ${op.resultTs} => {`,
        `      ${stubBody(parent, op.name)}`,
        `    },`
      );
    }
    lines.push('  },');
  };

  renderOps('Query');
  if (byParent('Mutation').length) renderOps('Mutation');

  for (const e of plan.enums) {
    const mapped = e.members.filter((m) => m.renamed);
    if (!mapped.length) continue;
    lines.push(
      `  ${e.typeName}: { ${mapped.map((m) => `${m.name}: ${q(m.value)}`).join(', ')} },`
    );
  }

  if (plan.renamedSelect.length) {
    lines.push(`  ${plan.typeName}: {`);
    for (const p of plan.renamedSelect) {
      const type = `${p.rowTs}${p.column.nullable ? ' | null' : ''}`;
      lines.push(`    ${p.field}: (parent: ${plan.typeName}): ${type} => parent[${q(p.column.name)}],`);
    }
    lines.push('  },');
  }

  lines.push('}');
  return lines.join('\n');
}

function renderTable(plan: TablePlan): string {
  const t = plan.table;
  const declared: string[] = [];

  declared.push(
    `/** One ${t.name} row, as your resolvers return it: database values, database spellings. */`,
    `export interface ${plan.typeName} {`,
    ...plan.select.map(rowField),
    '}'
  );
  if (plan.hasCreate) {
    declared.push(
      '',
      `/** The create${plan.typeName} input, as GraphQL hands it to your resolver. */`,
      `export interface ${plan.createInput} {`,
      ...plan.insert.map((p) => inputField(p, 'insert')),
      '}'
    );
  }
  if (plan.hasUpdate) {
    declared.push(
      '',
      `/** The update${plan.typeName} patch: every field optional, primary key excluded. */`,
      `export interface ${plan.updateInput} {`,
      ...plan.update.map((p) => inputField(p, 'update')),
      '}'
    );
  }

  const tsName = gqlIdent(t.tsName);
  const notes = plan.notes.length
    ? plan.notes.map((n) => `// ${n.replace(/\n/g, ' ')}`).join('\n') + '\n'
    : '';

  return `// Generated by @drzl/generator-graphql
// GraphQL SDL and resolver stubs for table: ${t.name}
${notes}${declared.join('\n')}

/** The SDL for this table's types. The Query and Mutation fields live in the barrel. */
export const ${tsName}TypeDefs = \`${tpl(renderTypeSdl(plan))}\`;

/** Stubs that throw until replaced, plus the enum value maps and field resolvers the schema needs. */
export const ${tsName}Resolvers = ${renderResolvers(plan)};
`;
}

/**
 * The scalar-config module. Dependency-free on purpose: the configs are plain objects the
 * consumer's own graphql interprets, so no realm is ever crossed and no peer range is imposed.
 * Every hook is named twice, because graphql 17 renamed them and @graphql-tools/schema assigns
 * whatever keys the object carries onto the built scalar type: 16 reads `serialize`,
 * `parseValue` and `parseLiteral`, 17 reads `coerceOutputValue`, `coerceInputValue` and
 * `coerceInputLiteral`, and a config naming only the legacy three measures broken on 17 (the
 * variable path skips parseValue and hands the resolver the raw JSON value).
 */
function renderScalarsModule(): string {
  return `// Generated by @drzl/generator-graphql
// Dependency-free scalar configs for the resolvers map. Each hook is named twice because
// graphql 17 renamed serialize/parseValue/parseLiteral to coerceOutputValue/coerceInputValue/
// coerceInputLiteral, and the schema builder assigns whichever names the running graphql reads.

/** The literal AST shape the literal hooks read, structurally, so nothing is imported. */
export interface LiteralNode {
  kind: string;
  value?: unknown;
  values?: LiteralNode[];
  fields?: { name: { value: string }; value: LiteralNode }[];
  name?: { value: string };
}

// Strict ISO 8601 datetime with seconds and an offset: new Date('1') is the year 2001.
const ISO_DATETIME = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$/;

const toIso = (value: unknown): string => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  throw new Error('DateTime.serialize: expected a Date');
};
const fromIso = (value: unknown): Date => {
  if (typeof value !== 'string' || !ISO_DATETIME.test(value)) {
    throw new Error('DateTime: expected a strict ISO 8601 datetime string');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('DateTime: unreadable datetime string');
  return parsed;
};
const fromIsoLiteral = (ast: LiteralNode): Date => {
  if (ast.kind !== 'StringValue') throw new Error('DateTime: expected a string literal');
  return fromIso(ast.value);
};

/** ISO 8601 datetime string in, real Date to the resolver, toISOString() out. */
export const DateTimeScalar = {
  name: 'DateTime',
  description: 'A strict ISO 8601 datetime string, e.g. 2026-01-02T03:04:05.000Z.',
  serialize: toIso,
  parseValue: fromIso,
  parseLiteral: fromIsoLiteral,
  coerceOutputValue: toIso,
  coerceInputValue: fromIso,
  coerceInputLiteral: fromIsoLiteral,
};

const DIGITS = /^-?\\d+$/;

const toDigits = (value: unknown): string => {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && DIGITS.test(value)) return value;
  throw new Error('BigInt.serialize: expected a bigint or a decimal digit string');
};
// Variables take the digit string only: a JSON number was already rounded by JSON.parse.
const fromDigits = (value: unknown): string => {
  if (typeof value !== 'string' || !DIGITS.test(value)) {
    throw new Error('BigInt: expected a string of decimal digits');
  }
  return value;
};
// An inline integer literal is lossless: the AST carries its raw digits as a string.
const fromDigitsLiteral = (ast: LiteralNode): string => {
  if (ast.kind === 'IntValue') return String(ast.value);
  if (ast.kind === 'StringValue' && typeof ast.value === 'string' && DIGITS.test(ast.value)) {
    return ast.value;
  }
  throw new Error('BigInt: expected an integer literal or a string of decimal digits');
};

/** A 64-bit-safe integer crossing the wire as its decimal digits. */
export const BigIntScalar = {
  name: 'BigInt',
  description: 'An arbitrary-precision integer as a string of decimal digits.',
  serialize: toDigits,
  parseValue: fromDigits,
  parseLiteral: fromDigitsLiteral,
  coerceOutputValue: toDigits,
  coerceInputValue: fromDigits,
  coerceInputLiteral: fromDigitsLiteral,
};

const identity = (value: unknown): unknown => value;
const fromJSONLiteral = (ast: LiteralNode, variables?: Record<string, unknown> | null): unknown => {
  switch (ast.kind) {
    case 'StringValue':
    case 'BooleanValue':
    case 'EnumValue':
      return ast.value;
    case 'IntValue':
    case 'FloatValue':
      return Number(ast.value);
    case 'NullValue':
      return null;
    case 'ListValue':
      return (ast.values ?? []).map((v) => fromJSONLiteral(v, variables));
    case 'ObjectValue': {
      const out: Record<string, unknown> = {};
      for (const f of ast.fields ?? []) out[f.name.value] = fromJSONLiteral(f.value, variables);
      return out;
    }
    case 'Variable':
      return variables ? variables[ast.name?.value ?? ''] : undefined;
    default:
      throw new Error('JSON: unsupported literal kind ' + ast.kind);
  }
};

/** Any JSON value, untouched on both value paths, rebuilt from the AST for inline literals. */
export const JSONScalar = {
  name: 'JSON',
  description: 'Any JSON value, passed through as-is.',
  serialize: identity,
  parseValue: identity,
  parseLiteral: fromJSONLiteral,
  coerceOutputValue: identity,
  coerceInputValue: identity,
  coerceInputLiteral: fromJSONLiteral,
};
`;
}

const SCALAR_EXPORTS: Record<string, string> = {
  DateTime: 'DateTimeScalar',
  BigInt: 'BigIntScalar',
  JSON: 'JSONScalar',
};

function renderBarrel(
  plans: TablePlan[],
  modules: Map<TablePlan, string>,
  usedScalars: string[],
  scalarsSpec: string
): string {
  if (!plans.length) {
    return `// Generated by @drzl/generator-graphql
// No tables detected in analysis. Add tables to your schema and regenerate.
// A GraphQL schema needs a Query type with at least one field, so no typeDefs are composed.
export * from '${scalarsSpec}';

export const typeDefs = '';

export const resolvers = {};
`;
  }

  const imports: string[] = [];
  if (usedScalars.length) {
    const names = usedScalars.map((s) => SCALAR_EXPORTS[s]).sort();
    imports.push(`import { ${names.join(', ')} } from '${scalarsSpec}';`);
  }
  for (const plan of plans) {
    const tsName = gqlIdent(plan.table.tsName);
    imports.push(
      `import { ${tsName}Resolvers, ${tsName}TypeDefs } from '${modules.get(plan)!}';`
    );
  }

  const reExports = [
    `export * from '${scalarsSpec}';`,
    ...plans.map((p) => `export * from '${modules.get(p)!}';`),
  ];

  const queryLines = plans.flatMap((p) =>
    p.ops
      .filter((o) => o.parent === 'Query')
      .map((o) => `  ${o.name}${o.argsSdl ? `(${o.argsSdl})` : ''}: ${o.resultSdl}`)
  );
  const mutationLines = plans.flatMap((p) =>
    p.ops
      .filter((o) => o.parent === 'Mutation')
      .map((o) => `  ${o.name}(${o.argsSdl}): ${o.resultSdl}`)
  );

  const typeDefParts: string[] = [
    ...usedScalars.map((s) => `'scalar ${s}'`),
    ...plans.map((p) => `${gqlIdent(p.table.tsName)}TypeDefs`),
    `\`${tpl(['type Query {', ...queryLines, '}'].join('\n'))}\``,
  ];
  if (mutationLines.length) {
    typeDefParts.push(`\`${tpl(['type Mutation {', ...mutationLines, '}'].join('\n'))}\``);
  }

  const resolverLines: string[] = ['export const resolvers = {'];
  for (const s of usedScalars) resolverLines.push(`  ${s}: ${SCALAR_EXPORTS[s]},`);
  for (const p of plans) {
    const tsName = gqlIdent(p.table.tsName);
    for (const e of p.enums) {
      if (e.members.some((m) => m.renamed)) {
        resolverLines.push(`  ${e.typeName}: ${tsName}Resolvers.${e.typeName},`);
      }
    }
    if (p.renamedSelect.length) {
      resolverLines.push(`  ${p.typeName}: ${tsName}Resolvers.${p.typeName},`);
    }
  }
  resolverLines.push('  Query: {');
  for (const p of plans) resolverLines.push(`    ...${gqlIdent(p.table.tsName)}Resolvers.Query,`);
  resolverLines.push('  },');
  const mutating = plans.filter((p) => p.ops.some((o) => o.parent === 'Mutation'));
  if (mutating.length) {
    resolverLines.push('  Mutation: {');
    for (const p of mutating) {
      resolverLines.push(`    ...${gqlIdent(p.table.tsName)}Resolvers.Mutation,`);
    }
    resolverLines.push('  },');
  }
  resolverLines.push('};');

  return `// Generated by @drzl/generator-graphql
// The whole schema in one pair: hand typeDefs and resolvers to makeExecutableSchema,
// createSchema (graphql-yoga) or new ApolloServer(...). Plain buildSchema(typeDefs) accepts
// the SDL too, but takes no resolvers, so scalar and enum behaviour will not attach there.
${imports.join('\n')}

${reExports.join('\n')}

/** The whole schema's SDL. */
export const typeDefs = [
${typeDefParts.map((p) => `  ${p},`).join('\n')}
].join('\\n\\n');

/** Everything merged. Override per field: { ...resolvers, Query: { ...resolvers.Query, users: yours } } */
${resolverLines.join('\n')}
`;
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

export class GraphQLGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions) {
    const fs = fileWriter(opts.fileSink);
    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outputDir);
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
    const scalarsPath = path.join(out, `${SCALARS_MODULE}.ts`);

    const plans = this.analysis.tables.map(planTable);
    const modules = new Map<TablePlan, string>();
    const total = plans.length;
    let index = 0;
    for (const plan of plans) {
      const base = `${plan.table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      // Both reserved names are refused up front: a table whose module would land on the barrel
      // or the scalars module must be renamed, not silently overwritten.
      if (filePath === barrelPath || filePath === scalarsPath) {
        const which = filePath === barrelPath ? 'the barrel' : 'the scalars module';
        throw new Error(
          `@drzl/generator-graphql: the module for table "${plan.table.name}" would be written ` +
            `to ${filePath}, which is ${which} this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
        );
      }
      await write(filePath, renderTable(plan));
      modules.set(
        plan,
        importSpecifier('./' + path.relative(out, filePath).replace(/\\/g, '/'), opts.importExtension)
      );
      index++;
      opts.onProgress?.({ index, total, table: plan.table.name, filePath });
    }

    const usedScalars = ['DateTime', 'BigInt', 'JSON'].filter((s) =>
      plans.some((p) => p.scalars.has(s))
    );
    const scalarsSpec = importSpecifier(`./${SCALARS_MODULE}.ts`, opts.importExtension);

    // The scalars module is a deliverable, not an internal helper: it is emitted even when the
    // current schema uses no custom scalar, so the import surface stays stable as columns are
    // added, the same decision as the NestJS generator's pipe module.
    await write(scalarsPath, renderScalarsModule());
    await write(barrelPath, renderBarrel(plans, modules, usedScalars, scalarsSpec));
    return { files };
  }
}

export default GraphQLGenerator;
