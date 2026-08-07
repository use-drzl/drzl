/**
 * A whole OpenAPI document, not just the schemas that go inside one.
 *
 * `componentsDocument` produces the half that describes rows. This is the other half: the paths, the
 * verbs on each, which schema backs each body, and what comes back when the schema does its job and
 * refuses a request. Everything here is derived from facts the analyzer already states; nothing is
 * invented, and where a fact is missing the document says less rather than guessing.
 *
 * The one decision everything else follows from is how a path addresses a row. `@drzl/generator-orpc`
 * answers it by emitting `z.object({ id: z.number() })` for every table, which names a column that
 * may not exist and types it as a number when it may be a uuid. `@drzl/generator-trpc` reads the
 * real primary key instead and drops the procedures that would have needed one rather than inventing
 * an `id`. This follows tRPC's, and the case for it is stronger here than there: a tRPC client is
 * typechecked against the router it calls, so a fictional `id` is at least caught at build time,
 * while an OpenAPI document is read by code generators in other languages that have nothing to check
 * it against. A wrong path parameter there becomes a client library that cannot call the API and no
 * compiler anywhere says so.
 */
import type { Column, Table } from '@drzl/analyzer';
import { tableSchemas, type JsonSchemaTarget, type Schema } from './schemas.js';

/** What the document says about itself. DRZL knows the schema and nothing else, so this is input. */
export interface OpenApiInfo {
  title?: string;
  version?: string;
  description?: string;
}

export interface OpenApiServer {
  url: string;
  description?: string;
}

export interface OpenApiDocumentOptions {
  target?: JsonSchemaTarget;
  applyDefaults?: boolean;
  /** Emit `/users/{id}/posts` for a child that names its parent by foreign key. */
  includeRelations?: boolean;
  info?: OpenApiInfo;
  servers?: OpenApiServer[];
  /**
   * Which status code answers a request that does not match its schema.
   *
   * Both readings are defensible and the ecosystem is genuinely split: RFC 9110 gives 400 to a
   * request the server will not process and 422 to one it understood and could not act on, which is
   * what a schema mismatch is, while most hand-written APIs answer 400. Exactly one is emitted, so
   * whichever is chosen is the one a consumer has to implement.
   */
  validationStatus?: 400 | 422;
}

type Mode = 'insert' | 'update' | 'select';

const ERROR_SCHEMA = 'Error';

/** The map key under `components.schemas`, which is also what a `$ref` to it spells. */
const componentName = (table: Table, mode: Mode) =>
  `${table.tsName}${mode[0].toUpperCase()}${mode.slice(1)}`;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The columns that address one row, or `null` when nothing does.
 *
 * Read off `primaryKey`, every column of it, at its real type. A table without one loses the paths
 * that would have needed it rather than gaining a fictional `id`. Copied in spirit from
 * `@drzl/generator-trpc`, deliberately, rather than approximated.
 */
function keyColumns(table: Table): Column[] | null {
  const names = table.primaryKey?.columns ?? [];
  if (!names.length) return null;
  const cols = names.map((n) => table.columns.find((c) => c.name === n));
  if (cols.some((c) => !c)) return null;
  return cols as Column[];
}

/**
 * Which modes of a table the document carries.
 *
 * Only what an operation in this document points at, which is narrower than all three in two cases.
 * A materialized view refuses every write, so an insert or update schema for one describes a row
 * that can never be written; and an update body only exists on a path that names a row, so a table
 * with no primary key has no operation that could carry one.
 *
 * `componentsDocument` still emits all three for every table, and that is not an inconsistency: it
 * hands over every schema it has and lets the caller pick. A document is the caller, and it may
 * carry only what something points at.
 */
const modesFor = (table: Table, key: Column[] | null): Mode[] => [
  ...(table.readOnly ? [] : (['insert'] as Mode[])),
  ...(table.readOnly || !key ? [] : (['update'] as Mode[])),
  'select',
];

/**
 * The URL segment naming a table's resource.
 *
 * The database table name rather than the TypeScript export name, because that is already the name a
 * DRZL user addresses a table by: `include` and `exclude` in the config are matched against it, and
 * that was itself a deliberate decision recorded in the config schema. Percent-encoded, since a
 * table name is not constrained to characters that are safe in a path.
 */
const resourceSegment = (table: Table) => encodeURIComponent(table.name);

/** Every foreign key the table declares, including the ones only mirrored onto a column. */
function foreignKeysOf(
  table: Table
): Array<{ columns: string[]; foreignTable: string; foreignColumns: string[] }> {
  if (table.foreignKeys?.length) return table.foreignKeys;
  return table.columns
    .filter((c) => c.references)
    .map((c) => ({
      columns: [c.name],
      foreignTable: c.references!.table,
      foreignColumns: [c.references!.column],
    }));
}

const jsonBody = (schema: Schema) => ({ content: { 'application/json': { schema } } });

function build(
  tables: Table[],
  opts: OpenApiDocumentOptions
): {
  paths: Record<string, Record<string, unknown>>;
  schemas: Record<string, Schema>;
  tags: Array<{ name: string; description: string }>;
} {
  const target = opts.target ?? 'draft-2020-12';
  // `draft-2020-12` and `openapi-3.1` differ only by the `$schema` declaration, which a schema
  // nested in a document must not carry at all: 3.1 reads it as a dialect switch. So there is no
  // third spelling of a document, and the plain draft is emitted as the 3.1 it already is.
  const schemaTarget: JsonSchemaTarget = target === 'openapi-3.0' ? 'openapi-3.0' : 'openapi-3.1';
  const failure = String(opts.validationStatus ?? 400);

  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, Schema> = {};
  const tags: Array<{ name: string; description: string }> = [];
  const operationIds = new Map<string, string>();
  const owner = new Map<string, { by: string; label: string }>();

  /**
   * Keyed on the Drizzle export name rather than on the table name, because the table name is
   * exactly what collides: two tables in different SQL schemas can share one, and the export names
   * cannot. Refusing rather than disambiguating follows `@drzl/generator-trpc`, which throws when
   * a router file would land on the module it also writes: silently overwriting one of the two is
   * the outcome nobody wants and nothing reports.
   */
  const claim = (path: string, by: string, label: string) => {
    const taken = owner.get(path);
    if (taken !== undefined && taken.by !== by) {
      throw new Error(
        `@drzl/generator-json-schema: the OpenAPI path "${path}" is claimed twice: by table ` +
          `"${taken.label}" (exported as ${taken.by}) and by table "${label}" (exported as ` +
          `${by}). A path names one resource, so one of the two has to be left out of this ` +
          `generator with the config's "exclude" list.`
      );
    }
    owner.set(path, { by, label });
  };

  const operation = (id: string, table: Table, rest: Record<string, unknown>) => {
    const clash = operationIds.get(id);
    if (clash !== undefined) {
      throw new Error(
        `@drzl/generator-json-schema: the operationId "${id}" would be emitted for both ` +
          `"${clash}" and "${table.name}". An operationId is the method name a client generator ` +
          `derives, and the specification requires it to be unique across the document.`
      );
    }
    operationIds.set(id, table.name);
    return { operationId: id, tags: [table.name], ...rest };
  };

  const built = tables.map((table) => ({
    table,
    key: keyColumns(table),
    segment: resourceSegment(table),
    schemas: tableSchemas(table, { target: schemaTarget, applyDefaults: opts.applyDefaults }),
  }));

  for (const { table, key, segment, schemas: built3 } of built) {
    for (const mode of modesFor(table, key)) {
      // `$schema` and `$id` both have to go. Nested under `components.schemas` a schema inherits
      // the document's dialect, and a 2020-12 `$id` may not contain a fragment, so the obvious
      // `#/components/schemas/<name>` makes a validator refuse the schema outright. The map key is
      // the identity and the `$ref` is written by whatever points at the schema.
      const { $schema: _dialect, $id: _id, ...rest } = built3[mode];
      schemas[componentName(table, mode)] = rest;
    }

    const notes: string[] = [];
    if (!key) notes.push('It has no primary key, so no path addresses a single row.');
    if (table.readOnly) {
      notes.push('It refuses every write, so only reads are described.');
    }
    tags.push({ name: table.name, description: [`Table "${table.name}".`, ...notes].join(' ') });

    const T = pascal(table.tsName);
    const select = ref(componentName(table, 'select'));
    const validationFailed = {
      description: 'The request does not match the schema for this operation.',
      ...jsonBody(ref(ERROR_SCHEMA)),
    };
    // A conflict is the one constraint a per-row schema structurally cannot state, because it is a
    // fact about the table rather than about the row. Emitted only where the schema declares
    // something that can collide, and the declaration is named so the reader knows what.
    const collidable = [
      ...(table.primaryKey ? [`primary key (${table.primaryKey.columns.join(', ')})`] : []),
      ...table.unique.map((u) => `${u.name ? `${u.name} ` : ''}(${u.columns.join(', ')})`),
    ];
    const conflict = (constraints: string[]) => ({
      description: `The row collides with an existing one on ${constraints.join('; ')}.`,
      ...jsonBody(ref(ERROR_SCHEMA)),
    });

    const collection = `/${segment}`;
    claim(collection, table.tsName, table.name);
    const item: Record<string, unknown> = {
      get: operation(`list${T}`, table, {
        summary: `List every ${table.name} row.`,
        // No pagination parameters. Whether the server implements a limit, an offset or a cursor is
        // not something a Drizzle schema states, and a declared parameter nothing honours is worse
        // than an undeclared one.
        responses: {
          '200': {
            description: `Every ${table.name} row.`,
            ...jsonBody({ type: 'array', items: select }),
          },
        },
      }),
    };
    if (!table.readOnly) {
      item.post = operation(`create${T}`, table, {
        summary: `Create a ${table.name} row.`,
        requestBody: { required: true, ...jsonBody(ref(componentName(table, 'insert'))) },
        responses: {
          '201': { description: `The ${table.name} row that was created.`, ...jsonBody(select) },
          [failure]: validationFailed,
          ...(collidable.length ? { '409': conflict(collidable) } : {}),
        },
      });
    }
    paths[collection] = item;

    if (!key) continue;

    const itemPath = `${collection}/${key.map((c) => `{${c.name}}`).join('/')}`;
    claim(itemPath, table.tsName, table.name);
    const parameters = key.map((c) => ({
      name: c.name,
      in: 'path',
      required: true,
      description: `${c.name}, from the primary key of ${table.name}.`,
      // The column's own schema rather than a string, so an integer key is declared as one and a
      // uuid key carries its format. This is the whole point of reading the real key.
      schema: (built3.select.properties as Record<string, Schema>)[c.name] ?? {},
    }));
    const missing = {
      description: `No ${table.name} row has that ${key.map((c) => c.name).join(' and ')}.`,
      ...jsonBody(ref(ERROR_SCHEMA)),
    };
    const byId: Record<string, unknown> = {
      parameters,
      get: operation(`get${T}`, table, {
        summary: `Read one ${table.name} row.`,
        responses: {
          '200': { description: `The requested ${table.name} row.`, ...jsonBody(select) },
          [failure]: validationFailed,
          '404': missing,
        },
      }),
    };
    if (!table.readOnly) {
      byId.patch = operation(`update${T}`, table, {
        summary: `Patch one ${table.name} row.`,
        requestBody: { required: true, ...jsonBody(ref(componentName(table, 'update'))) },
        responses: {
          '200': { description: `The ${table.name} row after the patch.`, ...jsonBody(select) },
          [failure]: validationFailed,
          '404': missing,
          // The primary key is not in the update schema, so a patch cannot collide on it. Only a
          // unique constraint over other columns can.
          ...(table.unique.length
            ? {
                '409': conflict(
                  table.unique.map((u) => `${u.name ? `${u.name} ` : ''}(${u.columns.join(', ')})`)
                ),
              }
            : {}),
        },
      });
      byId.delete = operation(`delete${T}`, table, {
        summary: `Delete one ${table.name} row.`,
        responses: {
          // No body. Handing back the deleted row is the alternative and it is not a true statement
          // on every dialect DRZL supports: RETURNING is Postgres and SQLite, and MySQL has no such
          // clause, so an implementation there has nothing to send.
          '204': { description: `The ${table.name} row was deleted. No content is returned.` },
          [failure]: validationFailed,
          '404': missing,
        },
      });
    }
    paths[itemPath] = byId;

    if (!opts.includeRelations) continue;

    for (const child of built) {
      // A self reference is skipped. `/users/{id}/posts` reads unambiguously because the child's
      // name is a different noun from the parent's; `/employees/{id}/employees` does not, and
      // nothing in the schema says whether it means this employee's reports or their managers. The
      // foreign key knows which direction it points, the path cannot say it, and a path a reader
      // has to guess at is worse than one that is not there.
      if (child.table === table) continue;
      // Exactly one foreign key from the child to this table's whole primary key. Two of them and
      // the path is ambiguous about which one it follows, which is the same reason the nested
      // schemas drop a child with more than one key back to its parent.
      const matching = foreignKeysOf(child.table).filter(
        (fk) =>
          fk.foreignTable === table.name &&
          fk.foreignColumns.length === key.length &&
          fk.foreignColumns.every((c, i) => c === key[i].name)
      );
      if (matching.length !== 1) continue;
      const subPath = `${itemPath}/${child.segment}`;
      claim(
        subPath,
        `${table.tsName} -> ${child.table.tsName}`,
        `${table.name} -> ${child.table.name}`
      );
      paths[subPath] = {
        parameters,
        get: operation(`list${T}${pascal(child.table.tsName)}`, child.table, {
          summary: `List the ${child.table.name} rows belonging to one ${table.name} row.`,
          responses: {
            '200': {
              description: `The ${child.table.name} rows whose ${matching[0].columns.join(', ')} names this ${table.name} row.`,
              ...jsonBody({ type: 'array', items: ref(componentName(child.table, 'select')) }),
            },
            [failure]: validationFailed,
            '404': missing,
          },
        }),
      };
    }
  }

  return { paths, schemas, tags };
}

/**
 * The shape every error response points at.
 *
 * Open rather than closed, so an implementation can add a field without contradicting the document.
 * `message` is the one thing required, because a response that says nothing at all is not worth
 * declaring.
 *
 * Built fresh per document rather than shared from module scope. Everything else here is built per
 * call, and one object aliased into every document a process produces is a document that changes
 * when somebody edits another one.
 */
const errorSchema = (): Schema => ({
  title: 'error',
  description: 'What an operation returns when it does not return the row.',
  type: 'object',
  properties: {
    message: { type: 'string' },
    code: { type: 'string' },
  },
  required: ['message'],
  additionalProperties: true,
});

/**
 * The document.
 *
 * `servers` is absent unless the caller supplies one. That is not a gap left open: the
 * specification reads an absent or empty `servers` as a single server at `/`, meaning the document
 * describes whatever is serving it, and that is the only true statement a Drizzle schema supports.
 * A placeholder like `http://localhost:3000` would be a fabrication that tooling then follows.
 */
export function openApiDocument(
  tables: Table[],
  opts: OpenApiDocumentOptions = {}
): Record<string, unknown> {
  const target = opts.target ?? 'draft-2020-12';
  const { paths, schemas, tags } = build(tables, opts);
  if (ERROR_SCHEMA in schemas) {
    throw new Error(
      `@drzl/generator-json-schema: a table produced the component schema name "${ERROR_SCHEMA}", ` +
        `which the document already uses for its error responses.`
    );
  }
  return {
    openapi: target === 'openapi-3.0' ? '3.0.3' : '3.1.1',
    info: {
      title: opts.info?.title ?? 'API',
      version: opts.info?.version ?? '0.0.0',
      description:
        opts.info?.description ??
        'Generated by DRZL from a Drizzle schema. Paths, request bodies and response bodies are ' +
          'derived from the schema alone; nothing here has been checked against a running server.',
    },
    ...(opts.servers?.length ? { servers: opts.servers } : {}),
    paths,
    components: { schemas: { ...schemas, [ERROR_SCHEMA]: errorSchema() } },
    tags,
  };
}
