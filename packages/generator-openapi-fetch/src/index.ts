import { fileWriter, type FileSink } from '@drzl/validation-core';
import type { Analysis, Table } from '@drzl/analyzer';
import type { AffixOptions, ImportExtension } from '@drzl/validation-core';
import {
  formatCode,
  resolveAffix,
  resolveConfiguredImport,
  typeName,
} from '@drzl/validation-core';
import {
  componentSchemaName,
  openApiDocument,
  type OpenApiDocumentOptions,
} from '@drzl/generator-json-schema';

/**
 * A typed `openapi-fetch` client, derived from the document DRZL already emits.
 *
 * `@drzl/generator-json-schema` with `document: true` writes the OpenAPI document. This turns the
 * same document into the `paths` type `createClient<paths>()` takes, so a call like
 * `client.GET('/users/{id}', { params: { path: { id: 1 } } })` is checked against the real primary
 * key rather than against a hand-kept copy of the API.
 *
 * **The document is read, not re-derived.** `openApiDocument` is called here and its `paths` are
 * walked. Deriving the path set a second time is how a client and a document come to disagree about
 * a route that was renamed on one side, and feature 12 in this repo recorded the same lesson about
 * a drift report and its SQL emitter.
 *
 * ## Why the emitted type is not openapi-typescript's
 *
 * `openapi-typescript` produces a `paths` type from a document already, and its output is the
 * obvious thing to copy. Measured 2026-08-12 against `openapi-fetch@0.17.0`: it is far more than
 * `createClient` needs. Three shapes were compiled under `strict` and `nodenext`, each with
 * canaries for an undeclared path, an undeclared verb, a wrong path-parameter type and a missing
 * required parameter. All three type identically:
 *
 *   1. openapi-typescript's own output, 426 lines for a five-path document
 *   2. the same without the `operations` indirection table and without `?: never` for every verb
 *      the path does not declare
 *   3. the same again without the `headers` key and without `?: never` for the parameter kinds an
 *      operation does not take
 *
 * So this emits the third. It is a fraction of the size, it is readable, and nothing about the
 * typing is weaker for it.
 *
 * ## Why the error responses are emitted
 *
 * `openapi-fetch` splits its result into `data` and `error` by status, and the type of `error`
 * comes from the non-2xx responses the `paths` type declares. Measured, on a `paths` carrying only
 * its `200`:
 *
 *     result.error?.message        // type error: there is no shape to read
 *
 * and on one carrying the `404` and `400` the document already declares:
 *
 *     const msg: string | undefined = result.error?.message   // typed, no cast
 *
 * A client that omits them hands the caller an `error` they have to cast, on a document that says
 * exactly what an error looks like. So they are carried.
 */

/** What the emitted client module is called, before its extension. */
export const CLIENT_MODULE = 'client';

/** The interface the emitted module exports for `createClient<...>`. */
export const PATHS_TYPE = 'paths';

/** The local interface the emitted module gives the document's shared `Error` schema. */
const ERROR_TYPE = 'ApiError';

/** The document's own name for that schema, which a `$ref` spells. */
const ERROR_COMPONENT = 'Error';

export interface GenerateOptions {
  outputDir: string;
  /**
   * The factory the emitted module exports. Defaults to `createApiClient`.
   *
   * A factory rather than a constructed client, because a client carries a `baseUrl` and a
   * `fetch`, and neither is a fact about a Drizzle schema. Emitting a configured singleton would
   * bake one environment's URL into generated code.
   */
  clientName?: string;
  /**
   * Forwarded to `openApiDocument` verbatim, so the client and the document describe one API.
   *
   * Whatever is passed to the `json-schema` generator's `document` option belongs here too. The
   * two are not checked against each other, and cannot be: they run as separate generators. Passing
   * different options to each produces a client that describes a different API from the document
   * beside it, which is the one way to make these disagree.
   */
  document?: OpenApiDocumentOptions;
  /**
   * Where the row types come from. Required, and the generator refuses without it.
   *
   * A client is nothing but its types. `@drzl/generator-ts-rest` refuses on the same grounds and
   * for the same reason: emitting one against `unknown` would produce a module that compiles,
   * calls the right URLs and tells the caller nothing about what comes back.
   */
  validation?: {
    useShared?: boolean;
    importPath?: string;
    affix?: AffixOptions;
  };
  onProgress?: (info: { index: number; total: number; filePath: string }) => void;
  /** Where the file goes, so a test can drive this without touching a disk. */
  fileSink?: FileSink;
  format?: { enabled?: boolean; engine?: 'auto' | 'prettier' | 'biome'; configPath?: string };
  outputHeader?: { enabled?: boolean; text?: string };
  /** How every relative specifier this generator invents spells its extension. Defaults to `'js'`. */
  importExtension?: ImportExtension;
}

type Mode = 'insert' | 'update' | 'select';

/** The verbs `openapi-fetch` exposes, in the order a reader expects them on a path. */
const VERBS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface DocOperation {
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

interface DocParameter {
  name: string;
  in: string;
  schema?: unknown;
}

const isRef = (v: unknown): v is { $ref: string } =>
  !!v && typeof v === 'object' && typeof (v as { $ref?: unknown }).$ref === 'string';

/** The component a `$ref` names, or undefined for anything else. */
function refName(v: unknown): string | undefined {
  if (!isRef(v)) return undefined;
  const m = /^#\/components\/schemas\/(.+)$/.exec(v.$ref);
  return m ? m[1] : undefined;
}

/**
 * The TypeScript type a JSON Schema in the document stands for.
 *
 * Only three shapes ever reach this, because the document only ever emits three: a `$ref` to a
 * component, an array whose items are a `$ref`, and nothing at all on a 204. Anything else returns
 * `undefined` and the caller leaves the body out rather than typing it `unknown`, which would read
 * as "the server sends something unknowable" when it means "this generator did not recognise it".
 */
function tsTypeFor(schema: unknown, componentTypes: Map<string, string>): string | undefined {
  const direct = refName(schema);
  if (direct) return componentTypes.get(direct);

  if (!!schema && typeof schema === 'object') {
    const s = schema as { type?: unknown; items?: unknown };
    if (s.type === 'array') {
      const item = tsTypeFor(s.items, componentTypes);
      return item ? `${item}[]` : undefined;
    }
  }
  return undefined;
}

/** `{ 'application/json': T }`, or undefined where there is no JSON body to describe. */
function jsonSchemaOf(
  holder: { content?: Record<string, { schema?: unknown }> } | undefined
): unknown {
  return holder?.content?.['application/json']?.schema;
}

/**
 * Every component name in the document, against the type the validation generator exports for it.
 *
 * Both sides come from shared helpers rather than from string building: `componentSchemaName` is
 * what the document writes into a `$ref`, and `typeName` is what every validation generator names
 * its type alias. A component with no entry here is one no validation output declares, which today
 * is exactly the shared `Error` schema.
 */
function componentTypeMap(
  tables: Table[],
  affix: ReturnType<typeof resolveAffix>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const table of tables) {
    for (const mode of ['insert', 'update', 'select'] as Mode[]) {
      map.set(componentSchemaName(table, mode), typeName(mode, table.tsName, affix));
    }
  }
  map.set(ERROR_COMPONENT, ERROR_TYPE);
  return map;
}

/** One operation, as the object literal the `paths` type wants for it. */
function renderOperation(
  op: DocOperation,
  pathParams: DocParameter[],
  componentTypes: Map<string, string>,
  indent: string
): string {
  const lines: string[] = [];
  const pad = `${indent}  `;

  if (pathParams.length) {
    const fields = pathParams
      .map((p) => `${pad}    ${JSON.stringify(p.name)}: ${scalarTypeOf(p.schema)};`)
      .join('\n');
    lines.push(`${pad}parameters: {`, `${pad}  path: {`, fields, `${pad}  };`, `${pad}};`);
  }

  const body = tsTypeFor(jsonSchemaOf(op.requestBody), componentTypes);
  if (body) {
    lines.push(
      `${pad}requestBody: {`,
      `${pad}  content: { "application/json": ${body} };`,
      `${pad}};`
    );
  }

  const responses: string[] = [];
  for (const [status, response] of Object.entries(op.responses ?? {})) {
    const type = tsTypeFor(jsonSchemaOf(response), componentTypes);
    // A 204 declares no content, and `content: never` is how openapi-fetch reads "there is no body
    // here". Leaving the status out entirely would make it an undeclared status instead.
    responses.push(
      type
        ? `${pad}  ${status}: { content: { "application/json": ${type} } };`
        : `${pad}  ${status}: { content: never };`
    );
  }
  lines.push(`${pad}responses: {`, ...responses, `${pad}};`);

  return lines.join('\n');
}

/**
 * The TypeScript type for a path parameter, from the column's own schema in the document.
 *
 * The document puts the real column schema here rather than a string, which is the whole point of
 * reading the primary key: an integer key is declared as an integer and a uuid key carries its
 * format. Anything this does not recognise becomes `string`, because a path segment really is a
 * string and that is the honest floor rather than a guess.
 */
function scalarTypeOf(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return 'string';
  const s = schema as { type?: unknown };
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (t === 'integer' || t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return 'string';
}

export class OpenApiFetchGenerator {
  constructor(private analysis: Analysis) {}

  async generate(opts: GenerateOptions): Promise<{ files: string[] }> {
    if (!opts.validation?.useShared || !opts.validation?.importPath) {
      throw new Error(
        '@drzl/generator-openapi-fetch: a client is nothing but its types, so it needs ' +
          'validation.useShared and validation.importPath pointing at a validation generator\'s ' +
          'output directory. Add one to the config, or drop this generator.'
      );
    }

    const tables = this.analysis.tables;
    const affix = resolveAffix({ affix: opts.validation.affix });
    const componentTypes = componentTypeMap(tables, affix);

    const doc = openApiDocument(tables, opts.document ?? {}) as {
      paths?: Record<string, Record<string, unknown>>;
    };
    const paths = doc.paths ?? {};

    // Only the types a path actually references get imported. Importing every mode of every table
    // would put a name in scope that the validation output may not export: a read-only relation
    // has no insert or update schema, and `verbatimModuleSyntax` turns a missing one into an error
    // in the emitted file rather than in this one.
    const used = new Set<string>();
    const rendered: string[] = [];

    for (const [route, entry] of Object.entries(paths)) {
      const pathParams = ((entry.parameters as DocParameter[] | undefined) ?? []).filter(
        (p) => p.in === 'path'
      );
      const verbs = VERBS.filter((v) => v in entry);
      if (!verbs.length) continue;

      const body: string[] = [`  ${JSON.stringify(route)}: {`];
      for (const verb of verbs) {
        const op = entry[verb] as DocOperation;
        collectUsed(op, componentTypes, used);
        body.push(`    ${verb}: {`);
        body.push(renderOperation(op, pathParams, componentTypes, '    '));
        body.push('    };');
      }
      body.push('  };');
      rendered.push(body.join('\n'));
    }

    if (!rendered.length) {
      throw new Error(
        '@drzl/generator-openapi-fetch: the document describes no path, so there is no client to ' +
          'emit. A schema with no table, or one whose every table is excluded, produces this.'
      );
    }

    const path = await import('node:path');
    const out = path.resolve(process.cwd(), opts.outputDir);
    // Against the absolute output directory, because a `./` importPath is relative to where the
    // file lands rather than to the project root. Copying a project-relative path in here is the
    // mistake every options builder in this repo now has a `projectRelative()` helper to prevent.
    const spec = resolveConfiguredImport(
      opts.validation.importPath,
      out,
      process.cwd(),
      opts.importExtension
    );

    const imported = [...used].filter((t) => t !== ERROR_TYPE).sort();
    const code = renderModule({
      spec,
      imported,
      paths: rendered.join('\n'),
      clientName: opts.clientName ?? 'createApiClient',
      needsError: used.has(ERROR_TYPE),
    });

    const fs = fileWriter(opts.fileSink);
    await fs.mkdir(out, { recursive: true });

    const filePath = path.join(out, `${CLIENT_MODULE}.ts`);
    const formatted = await formatCode(
      withHeader(code, opts.outputHeader),
      filePath,
      opts.format
    );
    await fs.writeFile(filePath, formatted, 'utf8');
    opts.onProgress?.({ index: 0, total: 1, filePath });
    // The CLI reads `.files` off whatever a generator resolves to, and reports the list. Returning
    // nothing made it read `files` off `undefined`, which the parity spec caught before any user
    // did: the generator had written its file correctly and the command still failed.
    return { files: [filePath] };
  }
}

/** Every component type an operation names, so the import list is exactly what the file uses. */
function collectUsed(
  op: DocOperation,
  componentTypes: Map<string, string>,
  used: Set<string>
): void {
  const add = (schema: unknown) => {
    const t = tsTypeFor(schema, componentTypes);
    if (t) used.add(t.replace(/\[\]$/, ''));
  };
  add(jsonSchemaOf(op.requestBody));
  for (const response of Object.values(op.responses ?? {})) add(jsonSchemaOf(response));
}

function renderModule(args: {
  spec: string;
  imported: string[];
  paths: string;
  clientName: string;
  needsError: boolean;
}): string {
  const { spec, imported, paths, clientName, needsError } = args;
  const out: string[] = [];

  out.push(`import createClient, { type ClientOptions } from "openapi-fetch";`);
  if (imported.length) {
    out.push(`import type { ${imported.join(', ')} } from ${JSON.stringify(spec)};`);
  }
  out.push('');

  if (needsError) {
    out.push(
      '/** The document\'s shared error body, which every non-2xx response carries. */',
      `export interface ${ERROR_TYPE} {`,
      '  error: string;',
      '  message: string;',
      '  details?: unknown;',
      '}',
      ''
    );
  }

  out.push(
    '/**',
    ' * The API this client calls, in the shape `createClient` takes.',
    ' *',
    ' * Derived from the same OpenAPI document DRZL emits, so a path or a verb cannot be here and',
    ' * missing there.',
    ' */',
    `export interface ${PATHS_TYPE} {`,
    paths,
    '}',
    ''
  );

  out.push(
    '/**',
    ' * A client bound to this API.',
    ' *',
    ' * A factory rather than a ready-made client: a `baseUrl` is a fact about a deployment and not',
    ' * about a Drizzle schema, so baking one in would put an environment into generated code.',
    ' */',
    `export function ${clientName}(options: ClientOptions) {`,
    `  return createClient<${PATHS_TYPE}>(options);`,
    '}',
    '',
    `export type ApiClient = ReturnType<typeof ${clientName}>;`,
    ''
  );

  return out.join('\n');
}

/**
 * The header, in the shape every other generator writes it.
 *
 * A configured `text` is comment-prefixed line by line rather than inserted raw. Emitting it as
 * written puts a bare sentence at the top of a TypeScript module, which does not compile, and the
 * branch-parity spec caught exactly that: the fixture's `parity fixture` landed without its `//`.
 */
function withHeader(code: string, header: GenerateOptions['outputHeader']): string {
  if (header && header.enabled === false) return code;
  const text = header?.text?.trim();
  const lines = text
    ? text.split(/\r?\n/).map((l) => `// ${l}`)
    : [
        '// Generated by DRZL (@drzl/*)',
        "// Generated output is granted to you under your project's license.",
        '// You may use, copy, modify, and distribute without attribution.',
      ];
  return `${lines.join('\n')}\n\n${code}`;
}
