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
 * AI SDK tools, one module per table.
 *
 * The same thesis as `@drzl/generator-mcp` and a different surface. A tool hands a model a JSON
 * Schema and the model writes arguments against it; derive that schema from the column types alone
 * and the model learns that `age` is an integer and nothing else, so it guesses, the write reaches
 * the database, and the database refuses it. Pointed at DRZL's own schemas the same tool advertises
 * `{"type":"integer","minimum":18,"maximum":120}` and the invalid call never happens.
 *
 * One measurement changed what this emits, and it is not a small one. `tool()` takes any Standard
 * Schema, and the SDK's adapter decides whether a validation passed with `"value" in result`.
 * A valibot failure result is `{ value, typed, issues }`: it carries a `value` key **even when it
 * failed**. So every valibot validation failure is reported to the AI SDK as a success and the
 * invalid input reaches `execute`. Measured on 2026-08-11 against ai 7.0.59 and
 * @ai-sdk/provider-utils 5.0.26: `{ age: 7 }` against a schema demanding `>= 18` was accepted for
 * valibot and refused for zod and arktype, whose failure results carry no `value`.
 *
 * A generated valibot tool would therefore validate nothing at all, silently, which is the exact
 * failure this package exists to prevent. So valibot tools are emitted through `jsonSchema(...,
 * { validate })` with the parse spelled out, rather than handed over as a Standard Schema. zod and
 * arktype are passed through, because they work.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported tool-set identifier. */
  routerSuffix?: string;
  /** Casing applied to file names, identifiers and the tool-name stem. */
  procedureCase?: Case;
  /**
   * Placed in front of every tool name, so one tool set can carry two schemas without collision.
   *
   * A `ToolSet` is one flat object and a model picks by name, exactly like MCP.
   */
  toolPrefix?: string;
}

/** The barrel's filename stem, and the identifier it exports every tool under. */
export const BARREL_MODULE = 'index';
export const ALL_TOOLS = 'allTools';

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

interface LibDialect {
  number: string;
  string: string;
  boolean: string;
  date: string;
  /** A date crossing JSON, which is the only form a tool argument ever takes. */
  dateInput: string;
  unknown: string;
  json: string;
  bigintWire: string;
  binaryWire: string;
  binaryRead: string;
  enum: (values: string[]) => string;
  nullable: (base: string) => string;
  optional: (base: string) => string;
  object: (body: string) => string;
  objectInline: (body: string) => string;
  partialUpdate?: (schema: string) => string;
  /** Whether every field expression is emitted as a quoted string, which ArkType alone needs. */
  fieldIsString?: boolean;
  /** A reference to another schema constant used as a field value. */
  ref: (name: string) => string;
  infer: (schema: string) => string;
  /**
   * How a finished schema is handed to `tool({ inputSchema })`.
   *
   * Only valibot needs anything, and it needs it for a reason worth restating at the call site:
   * the SDK reads a validation result as a success whenever it has a `value` key, and a valibot
   * failure has one. See the module comment for the measurement.
   */
  toolSchema?: (expr: string) => string;
  /** Whatever that wrapper needs defined once per module. */
  preamble?: string;
  /**
   * The names the preamble needs from `ai` itself, which join the one import statement rather than
   * adding a second from the same specifier.
   */
  preambleAiNames?: string[];
  /** The imports the preamble needs from anywhere else. */
  preambleImports?: string[];
}

const q = (v: string) => JSON.stringify(v);
const lit = (v: string) => (/['\\]/.test(v) ? JSON.stringify(v) : `'${v}'`);

/**
 * The valibot adapter, emitted into any module that has a valibot tool in it.
 *
 * `jsonSchema()` takes the two halves separately: the document the model reads, and the check the
 * SDK runs. Handing both over explicitly is what routes around the adapter's `"value" in result`
 * test, which a valibot failure passes.
 */
/**
 * The valibot json value space, in the one spelling that can become a tool schema.
 *
 * `VALIBOT_JSON_SOURCE` in `@drzl/validation-core` is the shared one and cannot be used here: its
 * `v.finite()` and its plain-object guard both throw on conversion to JSON Schema, and a tool whose
 * schema cannot be converted cannot be described to a model at all.
 *
 * Dropping those two is not a weaker check for this input space. Every argument reaches a tool as
 * JSON the provider sent, so it has already been through `JSON.parse`, which cannot produce
 * `Infinity`, `NaN` or a class instance. The shared spelling stays as it is for the generators
 * whose json column is a value a driver handed back, where those cases are reachable.
 */
const MCP_STYLE_JSON_SOURCE = `type ${VALIBOT_JSON_CONST}Type =
  | string
  | number
  | boolean
  | null
  | ${VALIBOT_JSON_CONST}Type[]
  | { [key: string]: ${VALIBOT_JSON_CONST}Type };

const ${VALIBOT_JSON_CONST}: v.GenericSchema<${VALIBOT_JSON_CONST}Type> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null(),
    v.array(${VALIBOT_JSON_CONST}),
    v.record(v.string(), ${VALIBOT_JSON_CONST}),
  ])
);
`;

const VALIBOT_ADAPTER = 'drzlValibotTool';
const VALIBOT_ADAPTER_SOURCE = `/**
 * A valibot schema as an AI SDK schema, with the validation spelled out.
 *
 * Not handed over as a Standard Schema, deliberately. The SDK's adapter decides a validation
 * passed with \`'value' in result\`, and a valibot failure result is \`{ value, typed, issues }\`,
 * so every failure reads as a success and the invalid input reaches \`execute\`. Measured against
 * ai 7.0.59 and @ai-sdk/provider-utils 5.0.26: zod and arktype refuse, valibot accepts.
 */
function ${VALIBOT_ADAPTER}<TIn, TOut>(schema: v.GenericSchema<TIn, TOut>) {
  // \`toStandardJsonSchema\` and not the plain \`toJsonSchema\`, which throws
  // "The \"transform\" action cannot be converted to JSON Schema" on any date column: a date
  // arrives as a string and is transformed into a Date, so every table with one would fail here.
  // The standard wrapper converts the *input* side, which is the side a model writes.
  const document = toStandardJsonSchema(schema)['~standard'].jsonSchema.input({
    target: 'draft-07',
  });
  // Two type parameters and not one. \`v.GenericSchema<T>\` defaults its output to its input, and a
  // date column's input is a string while its output is a Date, so a single parameter demands the
  // two be equal and no schema with a transform in it can be passed. \`TOut\` is what \`validate\`
  // hands back, so it is what the tool is parameterised by.
  return jsonSchema<TOut>(document as Parameters<typeof jsonSchema>[0], {
    validate: (value) => {
      const result = v.safeParse(schema, value);
      return result.success
        ? { success: true as const, value: result.output }
        : { success: false as const, error: new Error(v.summarize(result.issues)) };
    },
  });
}
`;

const LIB_IMPORTS: Record<Lib, string> = {
  zod: "import { z } from 'zod';",
  valibot: "import * as v from 'valibot';",
  arktype: "import { type } from 'arktype';",
};

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
    json: VALIBOT_JSON_CONST,
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
    toolSchema: (e) => `${VALIBOT_ADAPTER}(${e})`,
    preamble: VALIBOT_ADAPTER_SOURCE,
    preambleAiNames: ['jsonSchema'],
    preambleImports: ["import { toStandardJsonSchema } from '@valibot/to-json-schema';"],
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);

/**
 * What survives as a tool name across the providers the AI SDK talks to.
 *
 * Letters, digits, underscore and dash. Narrower than MCP's own SEP-986 set, which also allows a
 * dot, because a tool name here becomes a function name in a provider's request: OpenAI's function
 * naming has never accepted a dot, and a name the provider rejects fails the whole call rather than
 * the one tool. Conservative on purpose: the SDK itself validates nothing, so nothing here would
 * report a bad name before the request went out.
 */
function toolSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

function keyColumns(table: Table): Column[] | null {
  const names = table.primaryKey?.columns ?? [];
  if (!names.length) return null;
  const cols = names.map((n) => table.columns.find((c) => c.name === n));
  if (cols.some((c) => !c)) return null;
  return cols as Column[];
}

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
 * Three of the four modes are arguments, arriving as JSON inside a tool call, so a `Date` column is
 * an ISO string and a binary one is base64 on the way in. `select` is the fourth and is never a
 * tool schema: it exists so the row type a filled-in `execute` returns is the shape of a real row.
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
        if (column.shape?.kind === 'json') return d.json;
        if (column.shape?.kind === 'buffer' || column.tsType === 'Uint8Array') {
          return mode === 'select' ? d.binaryRead : d.binaryWire;
        }
        return d.unknown;
    }
  })();
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

/** The exported tool set: `usersTools`, with `kebab` falling back to camel. */
function toolSetName(table: Table, naming?: NamingOptions): string {
  const c = naming?.procedureCase;
  const base = toCase(table.tsName, c === 'kebab' ? 'camel' : c);
  return `${base}${naming?.routerSuffix ? cap(naming.routerSuffix) : ''}Tools`;
}

/** The stem every tool name on this table is built from: `users` in `users_list`. */
function toolStem(table: Table, naming?: NamingOptions): string {
  const stem = toolSegment(toCase(table.tsName, naming?.procedureCase));
  return naming?.toolPrefix ? `${toolSegment(naming.toolPrefix)}${stem}` : stem;
}

/** `id`, or `orgId and userId` for a composite key. */
function keyPhrase(key: Column[]): string {
  const names = key.map((c) => c.name);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

interface Tool {
  op: string;
  description: string;
  inputSchema: string;
  /**
   * The annotated return type of `execute`.
   *
   * Not optional, and not inferred. A stub whose only statement is `throw` returns `Promise<never>`,
   * and `never` propagates into `tool()`'s inference until the call matches no overload at all:
   * measured as `Type 'ZodObject<...>' is not assignable to type 'FlexibleSchema<never>'`, which
   * names the input schema for a problem that is entirely about the output. Annotating each stub
   * says what a filled-in handler owes rather than leaving the compiler to guess from a throw.
   */
  returns: string;
  body: string[];
}

interface RenderContext {
  out: string;
}

export class AIGenerator {
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
    const modules: Array<{ table: Table; filePath: string; toolSet: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      if (filePath === barrelPath) {
        throw new Error(
          `@drzl/generator-ai: the tools for table "${table.name}" would be written to ` +
            `${filePath}, which is the ${BARREL_MODULE}.ts this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
        );
      }
      await write(filePath, renderTools(table, opts, ctx, lib));
      modules.push({ table, filePath, toolSet: toolSetName(table, opts.naming) });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    await write(barrelPath, renderBarrel(modules, ctx, path, opts));
    return { files };
  }
}

export default AIGenerator;

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
 * The ranges and lengths reach it through the JSON Schema the SDK derives from the input schema; a
 * `CHECK` comparing two columns cannot be expressed there at all, so naming it here is the only way
 * the model learns it exists.
 */
function checkSentence(table: Table): string {
  const checks = (table.checks ?? []).filter((c) => c.expression);
  if (!checks.length) return '';
  const listed = checks
    .map((c) => (c.name ? `${c.expression} (${c.name})` : c.expression))
    .join('; ');
  return ` The database also enforces: ${listed}.`;
}

const NOT_IMPLEMENTED = (op: string, table: Table) =>
  `throw new Error('Not implemented: ${op} ${table.tsName}.');`;

function renderTools(table: Table, opts: GenerateOptions, ctx: RenderContext, lib: Lib): string {
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
  const stem = toolStem(table, opts.naming);
  const human = table.name;

  const tools: Tool[] = [];

  tools.push({
    op: 'list',
    description:
      `Read rows from the ${human} table. ` +
      `Returns at most "limit" rows starting at "offset".`,
    inputSchema: listName,
    returns: `${rowType}[]`,
    body: [`const rows: ${rowType}[] = [];`, 'return rows;'],
  });

  if (key) {
    tools.push({
      op: 'get',
      description: `Read a single row of the ${human} table, addressed by ${keyPhrase(key)}.`,
      inputSchema: keyName,
      returns: `${rowType} | null`,
      body: [`const row: ${rowType} | null = null;`, 'return row;'],
    });
  }

  if (writable) {
    tools.push({
      op: 'create',
      description:
        `Insert one row into the ${human} table. Columns the database fills in, such as ` +
        `generated keys and defaulted timestamps, are optional here.` +
        checkSentence(table),
      inputSchema: insertName,
      returns: rowType,
      body: [NOT_IMPLEMENTED('create', table)],
    });
  }

  if (writable && key) {
    tools.push({
      op: 'update',
      description:
        `Change one row of the ${human} table. "where" addresses the row by ` +
        `${keyPhrase(key)}; only the columns present in "data" are written.` +
        checkSentence(table),
      inputSchema: updateInputName,
      returns: rowType,
      body: [NOT_IMPLEMENTED('update', table)],
    });

    tools.push({
      op: 'delete',
      description: `Remove one row from the ${human} table, addressed by ${keyPhrase(key)}.`,
      inputSchema: keyName,
      returns: 'boolean',
      body: [NOT_IMPLEMENTED('delete', table)],
    });
  }

  const setName = toolSetName(table, opts.naming);

  const entries = tools
    .map((t) => {
      const expr = d.toolSchema ? d.toolSchema(t.inputSchema) : t.inputSchema;
      // The argument is named for whether the body reads it: a stub whose only statement is `throw`
      // never touches it, and `noUnusedParameters` exempts a leading underscore.
      const arg = t.body.some((line) => /\binput\b/.test(line)) ? 'input' : '_input';
      return [
        `  ${objectKey(`${stem}_${t.op}`)}: tool({`,
        `    description: ${lit(t.description)},`,
        `    inputSchema: ${expr},`,
        `    execute: async (${arg}): Promise<${t.returns}> => {`,
        ...t.body.map((line) => `      ${line}`),
        `    },`,
        `  }),`,
      ].join('\n');
    })
    .join('\n');

  const body = `export const ${setName} = {\n${entries}\n} satisfies ToolSet;\n`;

  const useShared = !!opts.validation?.useShared && !!opts.validation?.importPath;
  const declared: string[] = [];
  if (!useShared) {
    if (writable) {
      declared.push(`export const ${insertName} = ${renderSchema(table, lib, 'insert')};`);
      declared.push(`export const ${updateName} = ${renderSchema(table, lib, 'update')};`);
    }
    // Declared and never handed to `tool()`: the row a filled-in `execute` returns is a real row,
    // so its type carries the generated key the insert shape omits and the `Date` the driver
    // really produces.
    declared.push(`export const ${selectName} = ${renderSchema(table, lib, 'select')};`);
  }

  if (key) {
    declared.push(
      `export const ${keyName} = ${d.objectInline(
        key.map((c) => field(c, lib, 'key')).join(', ')
      )};`
    );
  }

  // Bounded rather than open: an unbounded page size on a tool a model drives is a way to hand a
  // context window an entire table.
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

  const needsAdapter = !!d.toolSchema && decided.includes(`${VALIBOT_ADAPTER}(`);
  // One statement per specifier. Two `from 'ai'` lines compile identically and read as an
  // oversight, and a formatter does not merge them.
  const aiNames = ['tool', 'type ToolSet', ...(needsAdapter ? (d.preambleAiNames ?? []) : [])];
  imports.push(`import { ${aiNames.join(', ')} } from 'ai';`);
  if (needsAdapter) imports.push(...(d.preambleImports ?? []));
  if (LIB_USAGE[lib].test(decided)) imports.unshift(LIB_IMPORTS[lib]);

  const wide = table.columns.filter(isWide).map((c) => c.name);
  const wideNote = wide.length
    ? `// No validated type for ${wide.length === 1 ? 'this column' : 'these columns'}: ${wide.join(', ')}.\n` +
      `// DRZL could not derive one from the schema, so these tools accept any value there.\n`
    : '';

  // Both preambles are decided against the finished text rather than from the column list, which
  // is the same rule the imports follow: a module that mentions the name defines it.
  const jsonPreamble =
    lib === 'valibot' && decided.includes(VALIBOT_JSON_CONST) ? `\n${MCP_STYLE_JSON_SOURCE}` : '';
  const preamble = `${jsonPreamble}${needsAdapter ? `\n${d.preamble}` : ''}`;

  return `// Generated by @drzl/generator-ai
// AI SDK tools for table: ${table.name}
${wideNote}${imports.join('\n')}
${preamble}
${decided}`;
}

/**
 * The page-size field, spelled per library. All three were checked against a real conversion on
 * 2026-08-11 and produce the same bounded integer with a default.
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
  modules: Array<{ table: Table; filePath: string; toolSet: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions
): string {
  const entries = modules.map((m) => ({
    toolSet: m.toolSet,
    rel: importSpecifier(
      './' + path.relative(ctx.out, m.filePath).replace(/\\/g, '/'),
      opts.importExtension
    ),
  }));
  const imports = entries.map((e) => `import { ${e.toolSet} } from '${e.rel}';`).join('\n');
  const spread = entries.map((e) => `  ...${e.toolSet},`).join('\n');
  const reExports = entries.map((e) => `export * from '${e.rel}';`).join('\n');

  return `// Generated by @drzl/generator-ai
// Every generated tool, as one set.
import type { ToolSet } from 'ai';
${imports}

/**
 * Every table's tools in one object, which is what \`generateText\` and \`streamText\` take.
 *
 * Spread rather than nested: a \`ToolSet\` is flat, and a model picks a tool by its name.
 */
export const ${ALL_TOOLS} = {
${spread || '  // No tables in the analysis, so there is nothing to expose.'}
} satisfies ToolSet;

${reExports}
`;
}
