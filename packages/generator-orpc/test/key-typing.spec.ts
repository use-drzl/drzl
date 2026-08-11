/**
 * The addressing inputs of every emitted get, update and delete, typed from the primary key
 * itself (plan addendum BQ).
 *
 * The defect this pins: the oRPC surface hardcoded `{ id: z.number() }` for every key shape, at
 * two layers. The generator's input rewrite spelled it whatever the key was, in all three
 * validation libraries, and both template packages hardcoded the same object in their own
 * procedure code, with `@drzl/template-orpc-service` calling `Service.getById(input.id)` through
 * it. Measured on pg books/composite/keyless beside post-BP services: exactly 9 tsc errors,
 * 3x TS2345 (number into a varchar key), 3x TS2554 (one argument into a composite key's
 * parameter list), 3x TS2339 (methods a keyless service no longer has).
 *
 * The policy is the settled one from `@drzl/generator-service` and the tRPC procedures: every
 * column of `primaryKey`, at its real type, in the configured library's spelling; a composite
 * key keeps all of its columns; a keyless table loses the procedures that would have needed a
 * key rather than gaining a fictional `id`; a key column DRZL cannot type becomes the library's
 * `unknown` in the input, and the service template stubs those procedures with the reason
 * rather than emitting a call that does not compile. Integer-key emissions must not move a
 * byte, which the assertions on the exact old spellings below hold in place.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { ORPCGenerator } from '../src';

function col(name: string, tsType: string, over: Partial<Column> = {}): Column {
  return {
    name,
    tsType,
    dbType: tsType.toUpperCase(),
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  } as Column;
}

function table(name: string, over: Partial<Table> & { columns: Column[] }): Table {
  return { name, tsName: name, unique: [], indexes: [], ...over } as Table;
}

function analysis(tables: Table[], relations: Analysis['relations'] = []): Analysis {
  return { dialect: 'postgres', tables, enums: [], relations, issues: [] };
}

/** A serial integer key: the shape whose emission must not move a byte. */
const users = table('users', {
  columns: [col('id', 'number', { hasDefault: true, isGenerated: true }), col('email', 'string')],
  primaryKey: { columns: ['id'] },
});
/** A natural, non-numeric key. */
const books = table('books', {
  columns: [col('isbn', 'string'), col('title', 'string')],
  primaryKey: { columns: ['isbn'] },
});
/** A composite key, which no single scalar addresses. */
const memberships = table('memberships', {
  columns: [col('orgId', 'number'), col('userId', 'string'), col('role', 'string')],
  primaryKey: { columns: ['orgId', 'userId'] },
});
/** No primary key at all, so no row can be addressed. */
const logs = table('logs', { columns: [col('at', 'number'), col('what', 'string')] });
/** A key column the input schemas cannot type: bigint has no JSON transport. */
const ledgers = table('ledgers', {
  columns: [col('seq', 'bigint'), col('entry', 'string')],
  primaryKey: { columns: ['seq'] },
});
/** An enum key, addressed by its literals. */
const states = table('states', {
  columns: [col('kind', 'string', { enumValues: ['draft', 'live'] }), col('note', 'string')],
  primaryKey: { columns: ['kind'] },
});

async function router(
  t: Table,
  opts: Record<string, unknown> = {},
  extraTables: Table[] = [],
  relations: Analysis['relations'] = []
): Promise<string> {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-orpc-key-'));
  try {
    await new ORPCGenerator(analysis([t, ...extraTables], relations)).generate({
      outputDir,
      format: { enabled: false },
      ...opts,
    } as never);
    return await fs.readFile(path.join(outputDir, `${t.tsName}.ts`), 'utf8');
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
}

describe('an integer key keeps its historical spelling, byte for byte', () => {
  it('spells the zod input exactly as before', async () => {
    const source = await router(users, { template: 'standard' });
    expect(source).toContain('.input(z.object({ id: z.number() }))');
    expect(source).toContain('.input(z.object({ id: z.number(), data: UpdateusersSchema }))');
  });

  it('spells the valibot input exactly as before', async () => {
    const source = await router(users, {
      template: 'standard',
      validation: { library: 'valibot' },
    });
    expect(source).toContain('.input(v.object({ id: v.number() }))');
    expect(source).toContain('.input(v.object({ id: v.number(), data: UpdateusersSchema }))');
  });

  it('spells the arktype input exactly as before, single quotes included', async () => {
    const source = await router(users, {
      template: 'standard',
      validation: { library: 'arktype' },
    });
    expect(source).toContain(".input(type({ id: 'number' }))");
    expect(source).toContain(".input(type({ id: 'number', data: UpdateusersSchema }))");
  });
});

describe('a natural key is addressed at its real type, in every library', () => {
  it('zod', async () => {
    const source = await router(books, { template: 'standard' });
    expect(source).toContain('.input(z.object({ isbn: z.string() }))');
    expect(source).toContain('.input(z.object({ isbn: z.string(), data: UpdatebooksSchema }))');
    expect(source).not.toContain('id: z.number()');
  });

  it('valibot', async () => {
    const source = await router(books, {
      template: 'standard',
      validation: { library: 'valibot' },
    });
    expect(source).toContain('.input(v.object({ isbn: v.string() }))');
    expect(source).not.toContain('id: v.number()');
  });

  it('arktype', async () => {
    const source = await router(books, {
      template: 'standard',
      validation: { library: 'arktype' },
    });
    expect(source).toContain(".input(type({ isbn: 'string' }))");
    expect(source).not.toContain("id: 'number'");
  });

  it('addresses an enum key by its literals', async () => {
    const zod = await router(states, { template: 'standard' });
    expect(zod).toContain('.input(z.object({ kind: z.enum(["draft", "live"] as const) }))');
    const ark = await router(states, {
      template: 'standard',
      validation: { library: 'arktype' },
    });
    // The union carries quotes of its own, so the field value is JSON-encoded, which ArkType
    // reads identically to the single-quoted form.
    expect(ark).toContain('.input(type({ kind: "\'draft\' | \'live\'" }))');
  });
});

describe('a composite key keeps every column', () => {
  it('builds the input from all key columns, in key order', async () => {
    const source = await router(memberships, { template: 'standard' });
    expect(source).toContain('.input(z.object({ orgId: z.number(), userId: z.string() }))');
    expect(source).toContain(
      '.input(z.object({ orgId: z.number(), userId: z.string(), data: UpdatemembershipsSchema }))'
    );
  });
});

describe('a table with no primary key loses the procedures that need one', () => {
  for (const [label, opts] of [
    ['default template', {}],
    ['standard template', { template: 'standard' }],
    ['service template', { template: '@drzl/template-orpc-service' }],
  ] as const) {
    it(`emits list and create only (${label})`, async () => {
      const source = await router(logs, opts as Record<string, unknown>);
      expect(source).toContain('list: listLogs');
      expect(source).toContain('create: createLogs');
      expect(source).not.toContain('getLogs');
      expect(source).not.toContain('updateLogs');
      expect(source).not.toContain('deleteLogs');
    });
  }

  it('does not import a shared update schema nothing references', async () => {
    // The update input was the only mention of the update schema. With the procedure gone the
    // import would be dead, and dead imports fail consumers running noUnusedLocals.
    const source = await router(logs, {
      template: 'standard',
      validation: { useShared: true, library: 'zod', importPath: './schemas' },
    });
    expect(source).toContain('InsertlogsSchema');
    expect(source).toContain('SelectlogsSchema');
    expect(source).not.toContain('UpdatelogsSchema');
  });

  it('keeps all three shared imports for a keyed table, byte for byte', async () => {
    // Including the redundant `X as X` the emission has always spelled: the point of this case
    // is that a keyed table's import line does not move at all.
    const source = await router(users, {
      template: 'standard',
      validation: { useShared: true, library: 'zod', importPath: './schemas' },
    });
    expect(source).toContain(
      'import { InsertusersSchema as InsertusersSchema, UpdateusersSchema as UpdateusersSchema, SelectusersSchema as SelectusersSchema } from'
    );
  });
});

describe('the service template reaches the service through the real key', () => {
  it('wires a natural key through as input.<column>', async () => {
    const source = await router(books, { template: '@drzl/template-orpc-service' });
    expect(source).toContain('return await BookService.getById(input.isbn);');
    expect(source).toContain('return await BookService.update(input.isbn, input.data);');
    expect(source).toContain('return await BookService.delete(input.isbn);');
  });

  it('wires a composite key as one argument per key column, in key order', async () => {
    const source = await router(memberships, { template: '@drzl/template-orpc-service' });
    expect(source).toContain(
      'return await MembershipService.getById(input.orgId, input.userId);'
    );
    expect(source).toContain(
      'return await MembershipService.update(input.orgId, input.userId, input.data);'
    );
    expect(source).toContain('return await MembershipService.delete(input.orgId, input.userId);');
  });

  it('keeps the integer-key body byte for byte', async () => {
    const source = await router(users, { template: '@drzl/template-orpc-service' });
    expect(source).toContain('return await UserService.getById(input.id);');
    expect(source).toContain('return await UserService.update(input.id, input.data);');
  });

  it('passes the injected handle ahead of the key', async () => {
    const source = await router(memberships, {
      template: '@drzl/template-orpc-service',
      databaseInjection: { enabled: true, databaseType: 'Database' },
    });
    expect(source).toContain(
      'return await MembershipService.getById(context.db, input.orgId, input.userId);'
    );
  });

  it('wires a bigint key through its digits, which convert back exactly', async () => {
    // This case used to be the throwing stub, on the strength of a bigint having no JSON
    // transport. It has one: its decimal digits, pinned by the input schema, and `BigInt()` on a
    // string that pattern admitted is total. So the call is written rather than refused.
    const source = await router(ledgers, { template: '@drzl/template-orpc-service' });
    expect(source).toContain(String.raw`seq: z.string().regex(/^-?\d+$/)`);
    expect(source).toContain('return await LedgerService.getAll();');
    expect(source).toContain('return await LedgerService.create(input);');
    expect(source).toContain('return await LedgerService.getById(BigInt(input.seq));');
    expect(source).not.toContain('Not implemented: get ledgers.');
  });

  it('gives the standard template the same typed input, whose bodies stay stubs', async () => {
    // Nothing in a standard stub body touches a service, so the input is the whole of what this
    // template can get wrong, and it is now the wire form rather than `unknown`.
    const source = await router(ledgers, { template: 'standard' });
    expect(source).toContain(String.raw`seq: z.string().regex(/^-?\d+$/)`);
    expect(source).toContain('return null');
  });
});

describe('cross-table lookups address this table by its real key', () => {
  const authors = table('authors', {
    columns: [col('id', 'number', { hasDefault: true, isGenerated: true }), col('name', 'string')],
    primaryKey: { columns: ['id'] },
  });
  const keyedBooks = table('books', {
    columns: [col('isbn', 'string'), col('title', 'string'), col('authorId', 'number')],
    primaryKey: { columns: ['isbn'] },
    foreignKeys: [{ columns: ['authorId'], foreignTable: 'authors', foreignColumns: ['id'] }],
  });
  const rels: Analysis['relations'] = [
    { kind: 'one', from: 'books', to: 'authors' },
    { kind: 'many', from: 'authors', to: 'books' },
    { kind: 'many', from: 'logs', to: 'books' },
  ];

  it('takes the varchar key, not a fictional id', async () => {
    const source = await router(keyedBooks, { includeRelations: true }, [authors], [
      { kind: 'many', from: 'books', to: 'authors' },
    ]);
    expect(source).toContain('listAuthors');
    expect(source).toContain('.input(z.object({ isbn: z.string() }))');
  });

  it('emits none for a keyless table, which has no row to hang the relation off', async () => {
    const keylessLogs = table('logs', {
      columns: [col('at', 'number'), col('what', 'string')],
    });
    const source = await router(keylessLogs, { includeRelations: true }, [authors, keyedBooks], rels);
    expect(source).not.toContain('listBooks');
  });
});
