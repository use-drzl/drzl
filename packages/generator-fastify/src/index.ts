import type { Analysis, Column, Table } from '@drzl/analyzer';
import { tableSchemas, type Schema } from '@drzl/generator-json-schema';
import type { ImportExtension } from '@drzl/validation-core';
import { formatCode, importSpecifier, selectColumns } from '@drzl/validation-core';

/**
 * Fastify plugins, in Fastify's own idiom: JSON Schema on every route, compiled by the AJV
 * instance Fastify itself owns and serialized by fast-json-stringify from the response schemas.
 *
 * Why this is a generator and not a template: the same reason `@drzl/generator-hono` and
 * `@drzl/generator-express` are. A DRZL "template" is `ORPCTemplateHooks`, and both shipped ones
 * hand back oRPC source text, none of which is Fastify, so a Fastify template written against
 * that interface would emit a file that does not compile.
 *
 * Why this generator emits no validator of its own, unlike both of those: Fastify's native
 * validation IS JSON Schema. Every route takes `schema: { params, body, response }`, AJV compiles
 * the request schemas per route, and fast-json-stringify compiles the response schemas. DRZL
 * already builds JSON Schema from a Drizzle table in `@drzl/generator-json-schema` (published on
 * npm, verified 0.7.0 on the registry), so this generator imports its `tableSchemas()` builder as
 * a real dependency, calls it at generation time, and inlines the result as literals. The two
 * generators cannot drift because they run the same code, the emitted tree still has zero runtime
 * dependencies beyond `fastify` itself, and every semantic the builder carries (CHECK constraint
 * bounds, byte caps, formats, integer detection) arrives here for free. The alternative, emitting
 * standalone schema literals from a second builder, was rejected for exactly that drift.
 *
 * Three keys are adapted before inlining, each from a measurement on fastify 5.11.2 under Node
 * 22, not from the specs:
 *
 *   - `$schema` naming draft 2020-12 is refused at `app.ready()`: Fastify's default AJV is the
 *     draft-07 class and answers `no schema with key or ref "https://json-schema.org/..."`.
 *   - `$id` is accepted (even the same `$id` on two routes: `@fastify/ajv-compiler` 4.0.5
 *     defaults `addUsedSchema: false`, read off its `default-ajv-options.js`, which also spells
 *     the measured `coerceTypes: 'array'`, `removeAdditional: true` and `useDefaults: true`),
 *     but it is stripped anyway: it is a module-identity key for the
 *     json-schema generator's own files, and `componentsDocument` in that package strips it for
 *     its embedded copies for the same reason.
 *   - `prefixItems` (a 2020-12 keyword) is refused outright: `strict mode: unknown keyword`.
 *     The builder only ever emits it for the geometric tuple shapes, whose members are all the
 *     identical `{ type: 'number' }`, so a homogeneous `items` with the same `minItems` and
 *     `maxItems` is exactly the same constraint in the draft-07 spelling. Measured: the rewritten
 *     schema rejects a wrong-typed member and a wrong length over HTTP.
 *
 *   `contentEncoding`, `const`, type arrays for nullability, `format: 'date-time'` and
 *   `format: 'uuid'` were all measured through Fastify's default AJV and pass through unchanged;
 *   the formats are real assertions because `@fastify/ajv-compiler` installs `ajv-formats`.
 *
 * Path parameters are the place Fastify's defaults had to be constrained. Fastify configures AJV
 * with `coerceTypes: 'array'`, so a numeric key column typed `{ type: 'integer' }` accepts
 * whatever `Number()` accepts. Measured on fastify 5.11.2, `GET /users/:id` with that schema:
 *
 *   segment        type integer          type string + numeric pattern
 *   "1"            200, id = 1           200, id = "1"
 *   "-2"           200, id = -2          200, id = "-2"
 *   "1.5"          400                   200, id = "1.5"
 *   "%20"          200, id = 0           400
 *   "0x10"         200, id = 16          400
 *   "1e5"          200, id = 100000      400
 *   "abc"          400                   400
 *   "" (trailing)  400                   400
 *   "007"          200, id = 7           200, id = "007"
 *   "9007199254740993"  200, id = 9007199254740992 (silent precision loss)   200, unchanged
 *
 * The integer column reads `GET /users/%20` as row 0, which is the exact policy violation the
 * Hono and Express generators exist to refuse, so the emitted params schemas use the strict
 * string spelling: the same `^-?\d+(\.\d+)?$` those two generators settled on, which matches
 * their measured grid row for row. AJV options cannot fix this per route without handing the
 * consumer's instance a custom compiler, and `pattern` beside `type: integer` is ignored for
 * non-strings (measured: it also logs a strictTypes warning at startup). The consequence is
 * stated rather than hidden: a validated key reaches the handler as the raw string segment,
 * because without a type provider Fastify hands handlers untyped params anyway, and `Number()`
 * on a segment the pattern accepted is safe.
 *
 * Request bodies keep Fastify's own semantics, and this is a measured, documented divergence
 * from the Hono and Express generators rather than an accident. With the default
 * `coerceTypes: 'array'`, `{ email: 123 }` against `{ type: 'string' }` is coerced to "123" and
 * accepted, and `["x"]` is unwrapped to "x"; `removeAdditional: true` silently strips keys the
 * schema does not name. Missing required properties, enum outsiders, objects where scalars
 * belong, and malformed JSON are still refused (400), and unknown content types are 415. That is
 * how every hand-written Fastify app behaves, feeding Fastify's own machinery is this
 * generator's whole point, and the runtime spec pins the coercion cases so a change in Fastify's
 * defaults shows up as a failing test instead of a silent policy change.
 *
 * One more inherited semantic is stated rather than hidden, because the Hono and Express
 * generators decide it the other way: `@drzl/generator-json-schema`'s insert schemas require a
 * nullable column that has no default, on the published and tested reasoning that null is a
 * value and omitting the key is not sending null. Those two generators' inline schemas make
 * such a column optional on insert. This generator runs the shared builder precisely so the two
 * JSON Schema producers cannot drift, so `POST /users` here needs `bio: null` spelled out where
 * the Express routes accept its absence; the runtime spec pins both directions.
 *
 * The serializer is the part with no analogue elsewhere, and its measured behaviour (fastify
 * 5.11.2, fast-json-stringify compiled from the emitted select schemas) is why the response
 * schemas are generated from the same builder as the request ones:
 *
 *   payload property absent from the schema     silently omitted from the response
 *   required column missing from the payload    throws, 500 '"email" is required!'
 *   string "abc" where integer declared         throws, 500 'cannot be converted to an integer'
 *   numeric string "42" where integer           coerced to 42
 *   float 1.9 where integer                     truncated to 1, silently
 *   number 123 where string                     stringified to "123"
 *   null where non-nullable string              becomes "", silently
 *   NaN where number                            throws, 500
 *   Infinity where number                       becomes null, silently
 *   enum outsider                               passes through unchanged (enum is not enforced)
 *   Date instance under format: date-time       serialized as its ISO string
 *   bigint under the bigint string spelling     serialized as its decimal digits
 *   null payload under an object schema         becomes {}, silently
 *
 * Two design decisions fall straight out of that grid. First, a response schema that misses one
 * column would silently delete that column from every response, so the schemas are never written
 * by hand here and the runtime spec proves a full row round-trips with every column present and
 * correctly typed. Second, `null` for a missing row would serialize as `{}`, so unlike the
 * Express generator's `res.json(null)` the byId stub answers 404 with a declared error schema,
 * which is also the response-schema idiom Fastify documentation encourages.
 *
 * The write stubs throw rather than echoing input, the settled policy from the Hono generator:
 * the input is the insert shape, the declared reply is the select shape, and a rejected async
 * handler is answered 500 by Fastify's own error handling (measured; the runtime spec's paired
 * 400/500 assertions depend on it). Each route also states its reply type through the route
 * generics, `app.post<{ Reply: SelectusersRow }>`, which is the one place Fastify's types hold a
 * handler to its contract without a type provider: measured on fastify 5.11.2's typings, a
 * returned row with an enum outsider fails to compile. TypeBox's type provider could derive
 * those statically from the same schemas one day; see the package docs for why that road is
 * future work rather than a second variant here.
 */

export type Case = 'camel' | 'kebab' | 'snake';

export interface NamingOptions {
  /** Appended to `tsName` for the file name and the exported plugin identifier. */
  routerSuffix?: string;
  /** Casing applied to file names, identifiers and the registered URL prefix. */
  procedureCase?: Case;
}

/** The barrel's filename stem, and the module the assembled plugin is exported from. */
export const APP_MODULE = 'index';

export interface GenerateOptions {
  outputDir: string;
  includeRelations?: boolean;
  naming?: NamingOptions;
  onProgress?: (info: { index: number; total: number; table: string; filePath: string }) => void;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /**
   * How every relative specifier this generator invents spells its extension: the barrel's import
   * of each route module. Defaults to `'js'`, the only form that resolves under every
   * `moduleResolution` without a compiler flag.
   */
  importExtension?: ImportExtension;
}

/**
 * A string literal in the emitted source, single-quoted where it can be.
 *
 * The formatter is an optional peer, so a project without prettier reads exactly these bytes, and
 * `JSON.stringify` would put double-quoted strings beside single-quoted imports. Anything
 * carrying a quote or a backslash falls back to `JSON.stringify`, which is correct for every
 * input.
 */
const lit = (v: string) => (/['\\]/.test(v) ? JSON.stringify(v) : `'${v}'`);

/**
 * What a path segment has to look like to be read as a number: optional sign, digits, optional
 * fractional part, and nothing else. The same source as the Hono and Express generators'
 * `NUMERIC_SEGMENT`, carried here as pattern data rather than as a regex literal because it is
 * emitted inside a JSON Schema. See the grid in the module comment for what it refuses that
 * Fastify's own integer coercion accepts.
 */
const NUMERIC_SEGMENT_PATTERN = '^-?\\d+(\\.\\d+)?$';

/** The digits of a bigint key, matching the string spelling its select schema already uses. */
const BIGINT_SEGMENT_PATTERN = '^-?\\d+$';

/**
 * The declared shape of the byId 404, inline in the route rather than exported: every table
 * module would otherwise export the same name, and two modules exporting one name make that name
 * unreachable through the barrel's `export *`.
 */
const NOT_FOUND_SCHEMA =
  "{ type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false }";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isIdent = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);

/**
 * The columns that address one row, or `null` when nothing does.
 *
 * A table with no primary key genuinely cannot be addressed. The key is read off `primaryKey`,
 * every column of it, at its real type, and a table without one loses the routes that would have
 * needed it rather than gaining a fictional `id`. A composite key keeps all of its columns, so
 * the path becomes `/:orgId/:userId`.
 */
function keyColumns(table: Table): Column[] | null {
  const names = table.primaryKey?.columns ?? [];
  if (!names.length) return null;
  const cols = names.map((n) => table.columns.find((c) => c.name === n));
  if (cols.some((c) => !c)) return null;
  return cols as Column[];
}

/**
 * The JSON Schema for one *path parameter*, which arrives as a string.
 *
 * Deliberately not the column's own schema: with Fastify's default `coerceTypes`, a numeric type
 * there reads `%20` as row 0. The strict string spellings are the ones whose measured grid
 * matches the Hono and Express generators; see the module comment. An enum key is already a set
 * of strings and is validated as exactly that set; a Date key takes `format: 'date-time'`, which
 * Fastify's AJV enforces (ajv-formats is installed by its compiler, measured); a key of any other
 * type keeps the string it was given rather than being validated against a type no path segment
 * can ever have.
 */
function segmentSchema(column: Column): Schema {
  if (column.enumValues && column.enumValues.length) return { enum: [...column.enumValues] };
  switch (column.tsType) {
    case 'number':
      return { type: 'string', pattern: NUMERIC_SEGMENT_PATTERN };
    case 'bigint':
      return { type: 'string', pattern: BIGINT_SEGMENT_PATTERN };
    case 'Date':
      return { type: 'string', format: 'date-time' };
    default:
      return { type: 'string' };
  }
}

function paramsSchema(cols: Column[]): Schema {
  return {
    type: 'object',
    properties: Object.fromEntries(cols.map((c) => [c.name, segmentSchema(c)])),
    required: cols.map((c) => c.name),
    additionalProperties: false,
  };
}

/**
 * A schema from `tableSchemas`, respelled for the AJV instance Fastify actually runs.
 *
 * `$schema` and `$id` go (the first is refused outright, the second is module identity this
 * inline copy does not have), and `prefixItems` becomes homogeneous `items` bounded by the
 * `minItems`/`maxItems` the builder already wrote beside it. The builder only emits
 * `prefixItems` whose members are all the identical `{ type: 'number' }` (the geometric tuple
 * shapes), so taking the first member loses nothing; the equality is asserted by a unit test
 * against a tuple column rather than trusted. Recursive, because an array column wraps its
 * element's schema, so a `point[]` carries the tuple one level down.
 */
function adaptForFastify(schema: Schema): Schema {
  const { $schema: _dialect, $id: _id, ...rest } = walk(schema) as Schema;
  return rest;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'prefixItems') continue;
      out[k] = walk(v);
    }
    const prefix = (value as { prefixItems?: unknown }).prefixItems;
    if (Array.isArray(prefix) && prefix.length) out.items = walk(prefix[0]);
    return out;
  }
  return value;
}

/**
 * The TypeScript type of one column of a returned row, on the handler's side of the serializer.
 *
 * A `Date` column is typed `Date` because that is what a Drizzle row carries and the serializer
 * writes it as its ISO string (measured); an ISO string a handler already has passes through
 * unchanged too. A `bigint` is typed `bigint` for the same reason: the serializer writes its
 * decimal digits under the string spelling the select schema uses (measured).
 */
function rowFieldType(column: Column): string {
  if (column.enumValues && column.enumValues.length) {
    return column.enumValues.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(' | ');
  }
  const s = column.shape;
  if (s) {
    switch (s.kind) {
      case 'tuple':
        return `[${Array.from({ length: s.length }, () => 'number').join(', ')}]`;
      case 'numberObject':
        return `{ ${s.fields.map((f) => `${f}: number`).join('; ')} }`;
      case 'numberVector':
        return 'number[]';
      default:
        return 'unknown';
    }
  }
  switch (column.tsType) {
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'Date':
      return 'Date';
    case 'bigint':
      return 'bigint';
    default:
      return 'unknown';
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

/** The exported identifier: `usersRoutes`, and `kebab` falls back to camel since `-` is invalid. */
function routesExportName(table: Table, naming?: NamingOptions): string {
  const base = `${table.tsName}${naming?.routerSuffix ?? 'Routes'}`;
  const c = naming?.procedureCase;
  return toCase(base, c === 'kebab' ? 'camel' : c);
}

/**
 * The URL prefix this table's plugin is registered under: `/users`.
 *
 * `tsName` and not `name`: it is the identifier the user wrote in their schema, and lowercasing
 * `userProfiles` into `userprofiles` is not harmless on a public URL surface.
 * `naming.procedureCase: 'kebab'` is how you ask for `/user-profiles`, and unlike the export name
 * a URL prefix can actually carry a hyphen.
 */
function mountPath(table: Table, naming?: NamingOptions): string {
  return `/${toCase(table.tsName, naming?.procedureCase)}`;
}

interface Route {
  /** For ordering only. */
  name: string;
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  /** The entries of the route's `schema` option, in Fastify's own order. */
  schema: string[];
  /** The `Reply` route generic: the one place Fastify's types hold a handler to its contract. */
  replyType: string;
  body: string[];
}

interface RenderContext {
  /** Absolute output directory. */
  out: string;
}

export class FastifyGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions) {
    const fs = await import('node:fs/promises');
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
    const modules: Array<{ table: Table; filePath: string; exportName: string }> = [];
    const total = this.analysis.tables.length;
    let index = 0;
    for (const table of this.analysis.tables) {
      const base = `${table.tsName}${opts.naming?.routerSuffix ?? ''}`;
      const filePath = path.join(out, `${toCase(base, opts.naming?.procedureCase)}.ts`);
      if (filePath === barrelPath) {
        throw new Error(
          `@drzl/generator-fastify: the routes for table "${table.name}" would be written to ` +
            `${filePath}, which is the barrel this generator also writes. Set ` +
            `naming.routerSuffix to move it out of the way.`
        );
      }
      await write(filePath, renderRoutes(table, opts));
      modules.push({ table, filePath, exportName: routesExportName(table, opts.naming) });
      index++;
      opts.onProgress?.({ index, total, table: table.name, filePath });
    }

    await write(barrelPath, renderBarrel(modules, ctx, path, opts));
    return { files };
  }
}

export default FastifyGenerator;

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

function renderRoutes(table: Table, opts: GenerateOptions): string {
  const insertName = `Insert${table.tsName}Schema`;
  const updateName = `Update${table.tsName}Schema`;
  const selectName = `Select${table.tsName}Schema`;
  // Not shared with the json-schema generator's own modules: a params schema is this generator's
  // invention, because only a router knows that these particular columns arrive as path segments.
  const paramsName = `${cap(table.tsName)}ParamsSchema`;
  const rowType = `Select${table.tsName}Row`;

  // A materialized view refuses every write, so a create, update or delete route on one describes
  // an operation the database always rejects.
  const writable = !table.readOnly;
  const key = keyColumns(table);

  const routes: Route[] = [];
  const notImplemented = (what: string) =>
    `throw new Error('Not implemented: ${what} ${table.tsName}.');`;
  const paramHint =
    `// Fastify has already validated req.params against ${paramsName}; numeric key segments ` +
    `stay strings here.`;

  // list -----------------------------------------------------------------------------------------
  routes.push({
    name: 'list',
    method: 'get',
    path: '/',
    schema: [`response: { 200: { type: 'array', items: ${selectName} } }`],
    replyType: `${rowType}[]`,
    // The stub states its contract twice over: the annotated local is what a reader sees, and the
    // Reply generic is what Fastify's own types hold the handler to. The response schema is what
    // the serializer runs; nothing infers a client from any of them, which the docs say plainly.
    body: [`const rows: ${rowType}[] = [];`, 'return rows;'],
  });

  if (key) {
    const keyPath = '/' + key.map((c) => `:${c.name}`).join('/');

    // byId ---------------------------------------------------------------------------------------
    // 404 rather than a 200 null: measured on fastify 5.11.2, a null payload under an object
    // response schema serializes as {}, so the Express generator's res.json(null) idiom would
    // answer an empty object here. The 404 carries its own declared schema.
    routes.push({
      name: 'byId',
      method: 'get',
      path: keyPath,
      schema: [
        `params: ${paramsName}`,
        `response: { 200: ${selectName}, 404: ${NOT_FOUND_SCHEMA} }`,
      ],
      replyType: `${rowType} | { message: string }`,
      body: [
        paramHint,
        `const row: ${rowType} | null = null;`,
        'if (row !== null) return row;',
        `return reply.code(404).send({ message: ${lit(`${table.tsName} row not found`)} });`,
      ],
    });

    if (writable) {
      // update -----------------------------------------------------------------------------------
      routes.push({
        name: 'update',
        method: 'patch',
        path: keyPath,
        schema: [
          `params: ${paramsName}`,
          `body: ${updateName}`,
          `response: { 200: ${selectName} }`,
        ],
        replyType: rowType,
        body: [notImplemented('update')],
      });

      // delete -----------------------------------------------------------------------------------
      routes.push({
        name: 'delete',
        method: 'delete',
        path: keyPath,
        schema: [`params: ${paramsName}`, `response: { 200: { type: 'boolean' } }`],
        replyType: 'boolean',
        body: [paramHint, 'return true;'],
      });
    }
  }

  if (writable) {
    // create -------------------------------------------------------------------------------------
    // Emitted with or without a primary key: inserting a row does not require being able to
    // address one afterwards.
    //
    // The stub throws rather than returning the validated body. The body is the insert shape,
    // where generated and defaulted columns are optional, the declared reply is the select shape,
    // where they are required, and without a type provider req.body is unknown besides, so
    // returning it is a compile error and not a loose placeholder. Fastify answers the rejected
    // handler with a 500, which the runtime spec's paired 400/500 assertions rely on.
    routes.push({
      name: 'create',
      method: 'post',
      path: '/',
      schema: [`body: ${insertName}`, `response: { 200: ${selectName} }`],
      replyType: rowType,
      body: [notImplemented('create')],
    });
  }

  // relation lookups -----------------------------------------------------------------------------
  if (opts.includeRelations) {
    routes.push(...relationRoutes(table, rowType, selectName, opts));
  }

  // Ordered so a reader finds CRUD where they expect it. Presentation only: find-my-way routes
  // static segments before parameters, so no ordering here changes which handler serves a
  // request; the relation lookups keep their literal prefix anyway, so a reader never has to
  // know that.
  const order = ['list', 'byId', 'create', 'update', 'delete'];
  const rank = (n: string) => (order.indexOf(n) === -1 ? order.length : order.indexOf(n));
  routes.sort((a, b) => rank(a.name) - rank(b.name));

  const exportName = routesExportName(table, opts.naming);

  const statements = routes
    .map((r) => {
      // Parameters are named for whether the body reads them; `noUnusedParameters` exempts a
      // leading underscore and a fully empty list. Comment lines are excluded: the params hint
      // mentions req.params, and counting it as a read would emit an unused req that
      // `noUnusedParameters` reports.
      const reads = (what: RegExp) =>
        r.body.some((line) => !line.startsWith('//') && what.test(line));
      const params = reads(/\breply\./)
        ? reads(/\breq\./)
          ? '(req, reply)'
          : '(_req, reply)'
        : reads(/\breq\./)
          ? '(req)'
          : '()';
      return [
        `  app.${r.method}<{ Reply: ${r.replyType} }>(${lit(r.path)}, {`,
        `    schema: { ${r.schema.join(', ')} },`,
        `  }, async ${params} => {`,
        ...r.body.map((line) => `    ${line}`),
        `  });`,
      ].join('\n');
    })
    .join('\n\n');

  const plugin = `export const ${exportName}: FastifyPluginAsync = async (app) => {\n${statements}\n};\n`;

  const schemas = tableSchemas(table);
  const declared: string[] = [];
  const emit = (name: string, schema: Schema) =>
    `export const ${name} = ${JSON.stringify(adaptForFastify(schema), null, 2)} as const;`;
  if (writable) {
    declared.push(emit(insertName, schemas.insert));
    declared.push(emit(updateName, schemas.update));
  }
  declared.push(emit(selectName, schemas.select));
  if (key) {
    declared.push(emit(paramsName, paramsSchema(key)));
  }

  const rowFields = selectColumns(table)
    .map((c) => `  ${objectKey(c.name)}: ${rowFieldType(c)}${c.nullable ? ' | null' : ''};`)
    .join('\n');
  declared.push(`export interface ${rowType} {\n${rowFields}\n}`);

  const wide = selectColumns(table)
    .filter((c) => rowFieldType(c) === 'unknown')
    .map((c) => c.name);
  const wideNote = wide.length
    ? `// No precise type for ${wide.length === 1 ? 'this column' : 'these columns'}: ${wide.join(', ')}.\n` +
      `// DRZL could not derive one from the schema, so these routes carry it as unknown and its\n` +
      `// schema constrains only what the builder could state.\n`
    : '';

  return `// Generated by @drzl/generator-fastify
// Routes for table: ${table.name}
${wideNote}import type { FastifyPluginAsync } from 'fastify';

${declared.join('\n\n')}

${plugin}`;
}

/**
 * One lookup route per single-column foreign key: `GET /posts/by-author-id/:authorId`.
 *
 * Named after the column, not the referenced table, because two keys frequently point at the same
 * table (`authorId` and `editorId` both referencing `users`) and naming by table would emit one
 * path twice.
 *
 * Restricted to single-column keys returning rows of *this* table, whose row type is already in
 * scope. The inverse direction needs another module's schema and that import is circular whenever
 * both directions exist, so it is absent rather than half-working.
 *
 * The segment keeps the literal prefix the Hono and Express generators use, and here it is
 * load-bearing rather than just clearer: measured on fastify 5.11.2, registering a bare
 * `/:authorId` beside `/:id` throws `Method 'GET' already declared for route` at registration,
 * because find-my-way reads both as the same single-parameter route.
 */
function relationRoutes(
  table: Table,
  rowType: string,
  selectName: string,
  opts: GenerateOptions
): Route[] {
  const out: Route[] = [];
  const taken = new Set<string>();
  for (const fk of table.foreignKeys ?? []) {
    if (fk.columns.length !== 1) continue;
    const colName = fk.columns[0];
    const column = table.columns.find((c) => c.name === colName);
    if (!column) continue;
    const segment = toCase(`by-${colName}`, opts.naming?.procedureCase ?? 'kebab');
    if (taken.has(segment)) continue;
    taken.add(segment);

    const params = JSON.stringify(paramsSchema([column]));
    out.push({
      name: `listBy${cap(colName)}`,
      method: 'get',
      path: `/${segment}/:${colName}`,
      schema: [`params: ${params}`, `response: { 200: { type: 'array', items: ${selectName} } }`],
      replyType: `${rowType}[]`,
      body: [`const rows: ${rowType}[] = [];`, 'return rows;'],
    });
  }
  return out;
}

/**
 * The barrel: one plugin registering every table's plugin under its prefix, plus the modules
 * re-exported so a consumer can register any single one into an app of their own.
 *
 * A plugin rather than a Fastify instance, deliberately: the consumer owns the instance and its
 * options (logger, AJV configuration, hooks), and `app.register(routes)` composes under any
 * prefix, so `app.register(routes, { prefix: '/api' })` serves `/api/users`. Registrations are
 * queued by Fastify and resolved before the instance is ready, so none of them needs an await.
 */
function renderBarrel(
  modules: Array<{ table: Table; filePath: string; exportName: string }>,
  ctx: RenderContext,
  path: typeof import('node:path'),
  opts: GenerateOptions
): string {
  if (!modules.length) {
    return `// Generated by @drzl/generator-fastify
// No tables detected in analysis. Add tables to your schema and regenerate.
import type { FastifyPluginAsync } from 'fastify';

export const routes: FastifyPluginAsync = async () => {};
`;
  }

  const entries = modules.map(({ filePath, exportName, table }) => ({
    rel: importSpecifier(
      './' + path.relative(ctx.out, filePath).replace(/\\/g, '/'),
      opts.importExtension
    ),
    exportName,
    mount: mountPath(table, opts.naming),
  }));

  const imports = entries.map((e) => `import { ${e.exportName} } from '${e.rel}';`).join('\n');
  const registrations = entries
    .map((e) => `  app.register(${e.exportName}, { prefix: ${lit(e.mount)} });`)
    .join('\n');
  const reExports = entries.map((e) => `export * from '${e.rel}';`).join('\n');

  return `// Generated by @drzl/generator-fastify
import type { FastifyPluginAsync } from 'fastify';
${imports}

export const routes: FastifyPluginAsync = async (app) => {
${registrations}
};

${reExports}
`;
}
