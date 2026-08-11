import {
  BIGINT_DIGITS_PATTERN as BIGINT_DIGITS,
  VALIBOT_JSON_CONST,
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
 * A Model Context Protocol server, one tool module per table.
 *
 * Why this generator exists, stated as the thing that is measurably different rather than as a
 * download count. An MCP tool hands a model a JSON Schema and the model writes arguments against
 * it. Every other way of building one of these from a Drizzle schema derives that JSON Schema from
 * the column *types*, so the model learns that `age` is an integer and nothing else; it guesses a
 * value, the write reaches the database, and the database refuses it. DRZL parses the table's
 * `CHECK` constraints, so the same tool advertises `{"type":"integer","minimum":18,"maximum":120}`
 * and the model never writes the invalid row in the first place. Measured through a real server
 * and a real client on 2026-08-11: the bound reaches `tools/list` and an out-of-range argument is
 * refused before the handler runs, in all three libraries this generator can emit.
 *
 * What it is not. It is not an adapter for the routers DRZL already emits: an MCP server speaks
 * JSON-RPC over stdio or streamable HTTP, not REST, and nothing in `@drzl/generator-hono` or
 * `@drzl/generator-trpc` produces a tool listing. It is not a template either, for the reason the
 * Hono generator records: a DRZL template hands back oRPC source text.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported registrar. */
  routerSuffix?: string;
  /** Casing applied to file names, identifiers and the tool-name stem. */
  procedureCase?: Case;
  /**
   * Placed in front of every tool name, so one server can carry two schemas without collision:
   * `db.users_list` rather than `users_list`.
   *
   * Tool names are a flat global namespace per server, unlike the URL trees the HTTP generators
   * emit, so this is the only thing that separates them.
   */
  toolPrefix?: string;
}

/**
 * Which generation of the TypeScript SDK the emitted server is written against.
 *
 * The two are different packages with different rules, established from the registry and from
 * running both on 2026-08-11:
 *
 *   @modelcontextprotocol/sdk     1.30.0   51.7M/wk   inputSchema: zod only
 *   @modelcontextprotocol/server   2.0.0    2.2M/wk   inputSchema: any Standard Schema with JSON
 *
 * The difference is not stylistic. v1 types `inputSchema` as `ZodRawShapeCompat | AnySchema` where
 * `AnySchema = z3.ZodTypeAny | z4.$ZodType`, and handed an arktype or valibot schema it throws
 * `inputSchema must be a Zod schema or raw shape, received an unrecognized object` at *registration
 * time*, so the server dies on startup rather than on a call. v2 takes `StandardSchemaWithJSON`,
 * the intersection of `StandardSchemaV1` and `StandardJSONSchemaV1`, which is why it accepts all
 * three.
 *
 * `v2` is the default despite being the smaller number, because it is the only one that works for
 * every library DRZL emits. Choosing `v1` with a non-zod library is refused by this generator with
 * that measurement in the message, rather than emitting a server that throws when you start it.
 */
export type SdkVersion = 'v1' | 'v2';

/** The barrel's filename stem, and the stdio entry point's. */
export const SERVER_MODULE = 'index';
export const STDIO_MODULE = 'stdio';

export interface GenerateOptions {
  outputDir: string;
  /** Which SDK generation the emitted code imports. See `SdkVersion`. */
  sdk?: SdkVersion;
  /** The `name` the server reports at initialize. Defaults to `'drzl'`. */
  serverName?: string;
  /** The `version` the server reports at initialize. Defaults to `'0.1.0'`. */
  serverVersion?: string;
  /**
   * Also emit `stdio.ts`, a runnable entry point that connects the server to a stdio transport.
   *
   * On by default, and in its own file rather than in the barrel: it is the only module that
   * imports a transport, and a project mounting the server on streamable HTTP instead deletes one
   * file rather than editing the barrel every time it is regenerated.
   */
  stdio?: boolean;
  // There is no `includeRelations` here, unlike the HTTP generators. A relation lookup is a
  // *route*, `GET /posts/by-author-id/:authorId`, and this generator emits tools rather than
  // routes; the equivalent would be a sixth tool per foreign key, which is a decision to make on
  // its own rather than an option to accept and ignore. `resolveConfig` reports a config that
  // sets it on this kind.
  naming?: NamingOptions;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /**
   * How every relative specifier this generator invents spells its extension. Defaults to `'js'`,
   * the only form that resolves under every `moduleResolution` without a compiler flag.
   */
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

interface LibDialect {
  number: string;
  string: string;
  boolean: string;
  date: string;
  /**
   * A date crossing JSON, which is the only form a tool argument ever takes.
   *
   * Unlike the HTTP generators there is no read side to tell apart here: every argument arrives
   * inside a JSON-RPC `tools/call` params object, so a `Date` column is an ISO string on the way
   * in whether the operation is a create, an update or a lookup by key. Strict, because
   * `new Date('1')` is the year 2001 and a lenient parse turns a model's typo into a row.
   */
  dateInput: string;
  unknown: string;
  json: string;
  bigintWire: string;
  binaryWire: string;
  /** Binary as the driver hands it back, for the select schema the row type is inferred from. */
  binaryRead: string;
  enum: (values: string[]) => string;
  nullable: (base: string) => string;
  optional: (base: string) => string;
  object: (body: string) => string;
  objectInline: (body: string) => string;
  partialUpdate?: (schema: string) => string;
  /** Whether every field expression is emitted as a quoted string, which ArkType alone needs. */
  fieldIsString?: boolean;
  /**
   * A reference to another schema *constant* used as a field value, which the quoted dialects
   * cannot spell the same way as an inline expression.
   *
   * ArkType quotes every field expression, and a quoted identifier is read as a string literal
   * type matching that sentence and nothing else. A `Type` object is a valid ArkType definition on
   * its own, so the reference is emitted bare there while the inline expressions beside it stay
   * quoted.
   */
  ref: (name: string) => string;
  /** The type of one parsed row, from the select schema. */
  infer: (schema: string) => string;
  /**
   * How a finished schema is handed to `registerTool`.
   *
   * Only valibot needs anything here, and the reason is measured rather than stylistic: v2's
   * `registerTool` takes `StandardSchemaWithJSON` and reads `~standard.jsonSchema` to build the
   * listing. Checked on 2026-08-11, zod 4.4.3 and arktype 2 both carry that property and valibot
   * 1.1 does not: its `~standard` has `version`, `vendor` and `validate` only. So a valibot schema
   * passed straight in is a type error and, at runtime, a tool with no advertised arguments.
   * `toStandardJsonSchema` from `@valibot/to-json-schema` is the wrapper the SDK's own
   * documentation names for exactly this, and it is what makes the constraint bounds show up.
   */
  toolSchema?: (expr: string) => string;
}

/**
 * The valibot json value space, in the one spelling that can become a tool schema.
 *
 * `VALIBOT_JSON_SOURCE` in `@drzl/validation-core` is the shared one, and it cannot be used here:
 * `registerTool` converts what it is handed to JSON Schema, and measured on 2026-08-11 that
 * conversion throws `The "finite" action cannot be converted to JSON Schema` on its `v.finite()`
 * and `The "custom" schema cannot be converted to JSON Schema` on its plain-object guard. A server
 * with one valibot json column would therefore fail its very first `tools/list`.
 *
 * Dropping those two is not a weaker check *for this input space*, which is the reason this is a
 * different schema rather than a compromise. Everything validated here has already been through
 * `JSON.parse`, because it arrived as the `arguments` of a JSON-RPC `tools/call`. `JSON.parse`
 * cannot produce `Infinity`, `NaN` or `undefined`, and it cannot produce a `Date` or any other
 * class instance, so the two cases those guards exist to catch are not in the input space at all.
 * The shared spelling stays as it is for the generators whose json column is a value a driver
 * handed back, where they are reachable.
 */
const MCP_VALIBOT_JSON_CONST = VALIBOT_JSON_CONST;
const MCP_VALIBOT_JSON_SOURCE = `type ${MCP_VALIBOT_JSON_CONST}Type =
  | string
  | number
  | boolean
  | null
  | ${MCP_VALIBOT_JSON_CONST}Type[]
  | { [key: string]: ${MCP_VALIBOT_JSON_CONST}Type };

const ${MCP_VALIBOT_JSON_CONST}: v.GenericSchema<${MCP_VALIBOT_JSON_CONST}Type> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null(),
    v.array(${MCP_VALIBOT_JSON_CONST}),
    v.record(v.string(), ${MCP_VALIBOT_JSON_CONST}),
  ])
);
`;

const q = (v: string) => JSON.stringify(v);

/** A string literal in the emitted source, single-quoted where it can be. */
const lit = (v: string) => (/['\\]/.test(v) ? JSON.stringify(v) : `'${v}'`);

/** The import each library's emitted expressions need, keyed the same way as `LIBS`. */
const LIB_IMPORTS: Record<Lib, string> = {
  zod: "import { z } from 'zod';",
  valibot: "import * as v from 'valibot';",
  arktype: "import { type } from 'arktype';",
};

/** Whether a finished file body actually mentions a library, so its import is emitted only there. */
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
    ref: (n) => n,
    infer: (s) => `z.output<typeof ${s}>`,
  },
  valibot: {
    number: 'v.number()',
    string: 'v.string()',
    boolean: 'v.boolean()',
    date: 'v.date()',
    dateInput: 'v.pipe(v.string(), v.isoTimestamp(), v.transform((s) => new Date(s)))',
    unknown: 'v.unknown()',
    json: MCP_VALIBOT_JSON_CONST,
    bigintWire: `v.pipe(v.string(), v.regex(${BIGINT_DIGITS}))`,
    binaryWire:
      'v.pipe(v.string(), v.base64(), v.transform((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))))',
    binaryRead: 'v.instance(Uint8Array)',
    enum: (vals) => `v.picklist([${vals.map(q).join(', ')}] as const)`,
    nullable: (b) => `v.nullable(${b})`,
    optional: (b) => `v.optional(${b})`,
    object: (body) => `v.object({\n${body}\n})`,
    objectInline: (body) => `v.object({ ${body} })`,
    ref: (n) => n,
    infer: (s) => `v.InferOutput<typeof ${s}>`,
    toolSchema: (e) => `toStandardJsonSchema(${e})`,
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
    enum: (vals) => vals.map((x) => `'${x.replace(/'/g, "\\'")}'`).join(' | '),
    nullable: (b) => `(${b} | null)`,
    optional: (b) => `${b}?`,
    object: (body) => `type({\n${body}\n})`,
    objectInline: (body) => `type({ ${body} })`,
    fieldIsString: true,
    ref: (n) => n,
    infer: (s) => `typeof ${s}.infer`,
  },
};

/** What each SDK generation is imported from, and what the emitted server calls it. */
const SDKS: Record<SdkVersion, { server: string; stdio: string; transport: string }> = {
  v2: {
    server: '@modelcontextprotocol/server',
    stdio: '@modelcontextprotocol/server/stdio',
    transport: 'StdioServerTransport',
  },
  v1: {
    server: '@modelcontextprotocol/sdk/server/mcp.js',
    stdio: '@modelcontextprotocol/sdk/server/stdio.js',
    transport: 'StdioServerTransport',
  },
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);

/**
 * What SEP-986 allows in a tool name: `/^[A-Za-z0-9._-]{1,128}$/`, read from the SDK's own
 * `TOOL_NAME_REGEX` rather than from the prose around it.
 *
 * A table whose name carries anything else would produce a name the SDK warns about and some
 * clients refuse, so the offending characters become underscores here. The 128 character ceiling
 * is not enforced: a table name long enough to reach it is a problem worth seeing rather than
 * silently truncating into a collision with its neighbour.
 */
function toolSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The columns that address one row, or `null` when nothing does.
 *
 * Same rule as the tRPC and Hono generators, including the reason: a table with no primary key
 * cannot be addressed, so it loses the tools that would have needed one rather than gaining a
 * fictional `id`. A composite key keeps every column.
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
  if (column.shape?.kind === 'json' || column.shape?.kind === 'buffer') return false;
  if (column.tsType === 'Uint8Array') return false;
  return !['number', 'string', 'boolean', 'Date', 'bigint'].includes(column.tsType);
}

type Mode = 'insert' | 'update' | 'key' | 'select';

/**
 * One column's expression, in the form that mode really carries.
 *
 * Three of the four modes are *arguments*: they arrive inside a JSON-RPC `tools/call` params
 * object, so a `Date` column is an ISO string and a binary one is base64 on the way in, whether the
 * operation is a create, an update or a lookup by key. That is not a style choice, it is what
 * makes them registrable. `registerTool` converts the schema it is handed to JSON Schema, and the
 * read-side spellings measurably cannot be converted: `z.date()` throws "Date cannot be
 * represented in JSON Schema", `z.instanceof(Uint8Array)` throws "Custom types cannot be
 * represented in JSON Schema", and arktype and valibot throw their own equivalents for `Date` and
 * for `TypedArray.Uint8`/`v.instance`. Measured across all three on 2026-08-11.
 *
 * `select` is the fourth, and it is never handed to `registerTool`. It exists so the row type a
 * filled-in handler returns is the shape of a real row, generated key included, rather than the
 * insert shape with the key missing. See the declaration of the select schema for why it is
 * emitted at all.
 */
function mapExpr(column: Column, lib: Lib, mode: Mode): string {
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
  // A key column addresses a row, so it is neither nullable nor optional whatever the column
  // declaration says: a null primary key matches nothing, and an absent one names no row.
  if (mode === 'key') return base;
  if (column.nullable) base = d.nullable(base);
  if (mode === 'select') return base;
  const optional = mode === 'update' || column.nullable || column.hasDefault;
  if (optional) base = d.optional(base);
  return base;
}

function objectKey(name: string): string {
  return isIdent(name) ? name : JSON.stringify(name);
}

function field(column: Column, lib: Lib, mode: Mode): string {
  const d = LIBS[lib];
  const expr = mapExpr(column, lib, mode);
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

/** The exported registrar: `registerUsersTools`, with `kebab` falling back to camel. */
function registrarName(table: Table, naming?: NamingOptions): string {
  const c = naming?.procedureCase;
  const base = toCase(table.tsName, c === 'kebab' ? 'camel' : c);
  return `register${cap(base)}${naming?.routerSuffix ? cap(naming.routerSuffix) : ''}Tools`;
}

/** The stem every tool name on this table is built from: `users` in `users_list`. */
function toolStem(table: Table, naming?: NamingOptions): string {
  const stem = toolSegment(toCase(table.tsName, naming?.procedureCase));
  return naming?.toolPrefix ? `${toolSegment(naming.toolPrefix)}${stem}` : stem;
}

interface Tool {
  /** For ordering only, and the suffix the tool name carries. */
  op: string;
  title: string;
  description: string;
  /**
   * The identifier of the schema constant holding this tool's arguments.
   *
   * Never absent, including for `list`, which takes a bounded `limit` and `offset` rather than
   * nothing: an unbounded page size on a tool a model drives is a way to hand a context window an
   * entire table.
   */
  inputSchema: string;
  annotations: Record<string, boolean>;
  body: string[];
}

interface RenderContext {
  /** Absolute output directory. */
  out: string;
}

export class MCPGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions) {
    const lib: Lib = (opts.validation?.library ?? 'zod') as Lib;
    const sdk: SdkVersion = opts.sdk ?? 'v2';
    assertSdkAcceptsLibrary(sdk, lib);

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

    const barrelPath = path.join(out, `${SERVER_MODULE}.ts`);
    const stdioPath = path.join(out, `${STDIO_MODULE}.ts`);
    const reserved = new Map<string, string>([[barrelPath, `${SERVER_MODULE}.ts`]]);
    if (opts.stdio !== false) reserved.set(stdioPath, `${STDIO_MODULE}.ts`);

    const modules: Array<{ table: Table; filePath: string; registrar: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      const clash = reserved.get(filePath);
      if (clash) {
        throw new Error(
          `@drzl/generator-mcp: the tools for table "${table.name}" would be written to ` +
            `${filePath}, which is the ${clash} this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
        );
      }
      await write(filePath, renderTools(table, opts, ctx, lib, sdk));
      modules.push({ table, filePath, registrar: registrarName(table, opts.naming) });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    await write(barrelPath, renderBarrel(modules, ctx, path, opts, sdk));
    if (opts.stdio !== false) await write(stdioPath, renderStdio(opts, sdk));
    return { files };
  }
}

export default MCPGenerator;

/**
 * Refuse a combination that cannot work, before anything is written.
 *
 * Not a warning. The failure it prevents is a `throw` inside `registerTool` the moment the server
 * starts, with a message naming neither DRZL nor the config key that caused it, and a generator
 * that knows the answer at emit time has no reason to let a user find it that way.
 */
function assertSdkAcceptsLibrary(sdk: SdkVersion, lib: Lib): void {
  if (sdk !== 'v1' || lib === 'zod') return;
  throw new Error(
    `@drzl/generator-mcp: sdk "v1" cannot carry ${lib} schemas. ` +
      `@modelcontextprotocol/sdk types inputSchema as a zod schema or raw shape and throws ` +
      `"inputSchema must be a Zod schema or raw shape, received an unrecognized object" at ` +
      `registration, so the emitted server would fail on startup rather than on a call. ` +
      `Use sdk "v2" (@modelcontextprotocol/server), which takes any Standard Schema, or set ` +
      `validation.library to "zod".`
  );
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

/**
 * The sentence a model reads before it writes arguments.
 *
 * Built from the schema rather than left to the caller, because the facts that make a tool usable
 * are facts only the analysis has: which columns the database fills in for you, and which `CHECK`
 * constraints it will refuse the row for. The ranges and lengths reach the model through the JSON
 * Schema the SDK derives from the input schema; a `CHECK` comparing two columns cannot be
 * expressed there at all, so naming it here is the only way the model learns it exists.
 */
function checkSentence(table: Table): string {
  const checks = (table.checks ?? []).filter((c) => c.expression);
  if (!checks.length) return '';
  const listed = checks
    .map((c) => (c.name ? `${c.expression} (${c.name})` : c.expression))
    .join('; ');
  return ` The database also enforces: ${listed}.`;
}

/** `id`, or `orgId and userId` for a composite key. */
function keyPhrase(key: Column[]): string {
  const names = key.map((c) => c.name);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const NOT_IMPLEMENTED = (op: string, table: Table) =>
  `throw new Error('Not implemented: ${op} ${table.tsName}.');`;

/**
 * The one result shape every MCP client understands.
 *
 * No `outputSchema`, and the reason is measured rather than an omission. `registerTool` converts
 * the schemas it is handed to JSON Schema, and a row is not convertible: `z.date()` throws "Date
 * cannot be represented in JSON Schema", `z.instanceof(Uint8Array)` throws "Custom types cannot be
 * represented in JSON Schema", and arktype and valibot throw their own equivalents for the same
 * two. Any table carrying a timestamp, which is nearly all of them, would therefore have a server
 * that dies at startup. The input schemas are safe because every one of them is a *wire* form: see
 * `mapExpr` for why this generator has no read side at all.
 */
function textResult(local: string): string {
  return `return { content: [{ type: 'text', text: JSON.stringify(${local}) }] };`;
}

function renderTools(
  table: Table,
  opts: GenerateOptions,
  ctx: RenderContext,
  lib: Lib,
  sdk: SdkVersion
): string {
  const d = LIBS[lib];

  const insertName = `Insert${table.tsName}Schema`;
  const updateName = `Update${table.tsName}Schema`;
  const selectName = `Select${table.tsName}Schema`;
  // The next three are this generator's own inventions: no validation generator emits a schema for
  // "the arguments of a tool", because only a tool knows that a key and a patch arrive together.
  const keyName = `${cap(table.tsName)}KeySchema`;
  const listName = `${cap(table.tsName)}ListInputSchema`;
  const updateInputName = `${cap(table.tsName)}UpdateInputSchema`;
  const rowType = `${cap(table.tsName)}Row`;

  const writable = !table.readOnly;
  const key = keyColumns(table);
  const stem = toolStem(table, opts.naming);
  const human = table.name;

  const tools: Tool[] = [];

  // list ------------------------------------------------------------------------------------
  tools.push({
    op: 'list',
    title: `List ${human}`,
    // No claim about ordering. The stub returns nothing and nothing sorts anything, so a
    // description promising "most recent first" would be a fact stated to a model that the code
    // does not implement, which is worse than saying less.
    description:
      `Read rows from the ${human} table. ` +
      `Returns at most "limit" rows starting at "offset".`,
    inputSchema: listName,
    // openWorldHint is false and that is a claim worth being deliberate about: it says the tool
    // touches a closed, known set of entities, which a table is. readOnlyHint is what a client
    // reads to decide it can call this without asking the user first.
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    body: [`const rows: ${rowType}[] = [];`, textResult('rows')],
  });

  if (key) {
    tools.push({
      op: 'get',
      title: `Get one ${human} row`,
      description: `Read a single row of the ${human} table, addressed by ${keyPhrase(key)}.`,
      inputSchema: keyName,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      body: [`const row: ${rowType} | null = null;`, textResult('row')],
    });
  }

  if (writable) {
    tools.push({
      op: 'create',
      title: `Create a ${human} row`,
      description:
        `Insert one row into the ${human} table. Columns the database fills in, such as ` +
        `generated keys and defaulted timestamps, are optional here.` +
        checkSentence(table),
      inputSchema: insertName,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      body: [NOT_IMPLEMENTED('create', table)],
    });
  }

  if (writable && key) {
    tools.push({
      op: 'update',
      title: `Update a ${human} row`,
      description:
        `Change one row of the ${human} table. "where" addresses the row by ` +
        `${keyPhrase(key)}; only the columns present in "data" are written.` +
        checkSentence(table),
      inputSchema: updateInputName,
      // Not destructive, and idempotent: writing the same patch twice leaves the same row. The
      // distinction matters to a client that auto-approves idempotent calls and prompts otherwise.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      body: [NOT_IMPLEMENTED('update', table)],
    });

    tools.push({
      op: 'delete',
      title: `Delete a ${human} row`,
      description: `Remove one row from the ${human} table, addressed by ${keyPhrase(key)}.`,
      inputSchema: keyName,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      body: [NOT_IMPLEMENTED('delete', table)],
    });
  }

  const registrar = registrarName(table, opts.naming);

  const registrations = tools
    .map((t) => {
      const config: string[] = [
        `      title: ${lit(t.title)},`,
        `      description: ${lit(t.description)},`,
      ];
      const expr = d.toolSchema ? d.toolSchema(t.inputSchema) : t.inputSchema;
      config.push(`      inputSchema: ${expr},`);
      config.push(
        `      annotations: { ${Object.entries(t.annotations)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ')} },`
      );
      // The argument is named for whether the body reads it. A stub whose only statement is
      // `throw` never touches it, and `noUnusedParameters` exempts a leading underscore.
      const arg = t.body.some((line) => /\binput\b/.test(line)) ? 'input' : '_input';
      return [
        `  server.registerTool(`,
        `    ${lit(`${stem}_${t.op}`)},`,
        `    {`,
        ...config,
        `    },`,
        `    async (${arg}) => {`,
        ...t.body.map((line) => `      ${line}`),
        `    }`,
        `  );`,
      ].join('\n');
    })
    .join('\n\n');

  const body = `export function ${registrar}(server: McpServer): void {\n${registrations}\n}\n`;

  const useShared = !!opts.validation?.useShared && !!opts.validation?.importPath;
  const declared: string[] = [];
  if (!useShared) {
    if (writable) {
      declared.push(`export const ${insertName} = ${renderSchema(table, lib, 'insert')};`);
      declared.push(`export const ${updateName} = ${renderSchema(table, lib, 'update')};`);
    }
    // Declared, and deliberately never handed to `registerTool`. The row a filled-in handler
    // returns is a real row, so its type has to include the generated key the insert shape omits
    // and the `Date` the driver really produces. That same `Date` is what makes this schema
    // unregistrable, which is the whole reason the tool schemas are built from the other modes.
    declared.push(`export const ${selectName} = ${renderSchema(table, lib, 'select')};`);
  }

  if (key) {
    declared.push(
      `export const ${keyName} = ${d.objectInline(
        key.map((c) => field(c, lib, 'key')).join(', ')
      )};`
    );
  }

  // Bounded rather than open, because an unbounded page size on a tool a model drives is a way to
  // hand a context window an entire table. The ceiling is a default a project can raise; what it
  // cannot be is absent.
  declared.push(
    `export const ${listName} = ${d.objectInline(
      [`limit: ${listLimit(lib)}`, `offset: ${listOffset(lib)}`].join(', ')
    )};`
  );

  if (writable && key) {
    declared.push(
      `export const ${updateInputName} = ${d.objectInline(
        [`where: ${d.ref(keyName)}`, `data: ${d.ref(updateName)}`].join(', ')
      )};`
    );
  }

  // The type the read stubs annotate themselves with, so filling one in is a compile error until
  // the shape is right rather than a loose `any`.
  declared.push(`export type ${rowType} = ${d.infer(selectName)};`);

  const decided = [...declared, body].join('\n\n');

  const imports: string[] = [];
  if (useShared) {
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

  imports.push(`import type { McpServer } from '${SDKS[sdk].server}';`);
  if (d.toolSchema && decided.includes('toStandardJsonSchema(')) {
    imports.push(`import { toStandardJsonSchema } from '@valibot/to-json-schema';`);
  }
  if (LIB_USAGE[lib].test(decided)) imports.unshift(LIB_IMPORTS[lib]);

  const wide = table.columns.filter(isWide).map((c) => c.name);
  const wideNote = wide.length
    ? `// No validated type for ${wide.length === 1 ? 'this column' : 'these columns'}: ${wide.join(', ')}.\n` +
      `// DRZL could not derive one from the schema, so these tools accept any value there.\n`
    : '';

  const jsonPreamble = decided.includes(MCP_VALIBOT_JSON_CONST)
    ? `\n${MCP_VALIBOT_JSON_SOURCE}`
    : '';

  return `// Generated by @drzl/generator-mcp
// Tools for table: ${table.name}
${wideNote}${imports.join('\n')}
${jsonPreamble}
${decided}`;
}

/**
 * The page-size field, spelled per library and defaulted so a model that omits it still gets a
 * page rather than an error.
 *
 * All three spellings were checked against a real conversion on 2026-08-11 and produce the same
 * `{"type":"integer","minimum":1,"maximum":200,"default":50}`, apply the default when the argument
 * is absent, and refuse 0 and 5000. The ArkType form is returned already quoted because that
 * dialect reads every field expression as a string.
 */
function listLimit(lib: Lib): string {
  if (lib === 'zod') return 'z.number().int().min(1).max(200).default(50)';
  if (lib === 'arktype') return JSON.stringify('1 <= number.integer <= 200 = 50');
  return 'v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(200)), 50)';
}

function listOffset(lib: Lib): string {
  if (lib === 'zod') return 'z.number().int().min(0).default(0)';
  if (lib === 'arktype') return JSON.stringify('number.integer >= 0 = 0');
  return 'v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0)';
}

function renderBarrel(
  modules: Array<{ table: Table; filePath: string; registrar: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions,
  sdk: SdkVersion
): string {
  const name = opts.serverName ?? 'drzl';
  const version = opts.serverVersion ?? '0.1.0';
  const entries = modules.map((m) => ({
    registrar: m.registrar,
    rel: importSpecifier(
      './' + path.relative(ctx.out, m.filePath).replace(/\\/g, '/'),
      opts.importExtension
    ),
  }));
  const imports = entries.map((e) => `import { ${e.registrar} } from '${e.rel}';`).join('\n');
  const reExports = entries.map((e) => `export * from '${e.rel}';`).join('\n');
  const calls = entries.map((e) => `  ${e.registrar}(server);`).join('\n');

  return `// Generated by @drzl/generator-mcp
// The assembled MCP server.
import { McpServer } from '${SDKS[sdk].server}';
${imports}

/** Registers every generated tool on a server you already have. */
export function registerAllTools(server: McpServer): void {
${calls || '  // No tables in the analysis, so there is nothing to register.'}
}

/**
 * A server carrying every generated tool, not yet connected to a transport.
 *
 * Separate from connecting it, so the same server can be served over stdio, over streamable HTTP,
 * or stood up in a test against an in-memory transport.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: ${lit(name)}, version: ${lit(version)} });
  registerAllTools(server);
  return server;
}

${reExports}
`;
}

function renderStdio(opts: GenerateOptions, sdk: SdkVersion): string {
  const { transport, stdio } = SDKS[sdk];
  return `// Generated by @drzl/generator-mcp
// A runnable stdio entry point: point an MCP client's command at this file.
import { ${transport} } from '${stdio}';
import { createServer } from '${importSpecifier(`./${SERVER_MODULE}.ts`, opts.importExtension)}';

const server = createServer();
await server.connect(new ${transport}());
`;
}
