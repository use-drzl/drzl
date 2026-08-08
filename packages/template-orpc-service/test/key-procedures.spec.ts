/**
 * The handler bodies, composed from the primary key instead of a hardcoded `input.id`.
 *
 * These bodies call the classes `@drzl/generator-service` emits, which type one parameter per
 * key column at the column's real type (plan addendum BP). The template used to pass
 * `input.id` regardless: a number into a varchar key's `id: string`, one argument into a
 * composite key's list, and a method that does not exist on a keyless table's service. The
 * runtime table object is the full analyzer table, so the key is read straight off it.
 */
import { describe, expect, it } from 'vitest';
import hooks from '../src/index';

const col = (name: string, tsType: string, over: Record<string, unknown> = {}) => ({
  name,
  tsType,
  ...over,
});

const users = {
  name: 'users',
  tsName: 'users',
  columns: [col('id', 'number'), col('email', 'string')],
  primaryKey: { columns: ['id'] },
} as never;

const books = {
  name: 'books',
  tsName: 'books',
  columns: [col('isbn', 'string'), col('title', 'string')],
  primaryKey: { columns: ['isbn'] },
} as never;

const memberships = {
  name: 'memberships',
  tsName: 'memberships',
  columns: [col('orgId', 'number'), col('userId', 'string'), col('role', 'string')],
  primaryKey: { columns: ['orgId', 'userId'] },
} as never;

const logs = {
  name: 'logs',
  tsName: 'logs',
  columns: [col('at', 'number'), col('what', 'string')],
} as never;

const ledgers = {
  name: 'ledgers',
  tsName: 'ledgers',
  columns: [col('seq', 'bigint'), col('entry', 'string')],
  primaryKey: { columns: ['seq'] },
} as never;

const codeOf = (table: never, name: string, injection = false) => {
  const procs = hooks.procedures(
    table,
    injection ? { databaseInjection: { enabled: true, databaseType: 'Database' } } : undefined
  );
  return procs.find((p) => p.name === name)?.code;
};

describe('an integer key keeps its historical body, byte for byte', () => {
  it('still reads input.id and spells the same input object', () => {
    expect(codeOf(users, 'get')).toContain('.input(z.object({ id: z.number() }))');
    expect(codeOf(users, 'get')).toContain('return await UserService.getById(input.id);');
    expect(codeOf(users, 'update')).toContain(
      '.input(z.object({ id: z.number(), data: z.any() }))'
    );
    expect(codeOf(users, 'update')).toContain(
      'return await UserService.update(input.id, input.data);'
    );
    expect(codeOf(users, 'delete')).toContain('return await UserService.delete(input.id);');
  });
});

describe('keys the service layer expresses', () => {
  it('addresses a natural key by its column, at its type', () => {
    expect(codeOf(books, 'get')).toContain('.input(z.object({ isbn: z.string() }))');
    expect(codeOf(books, 'get')).toContain('return await BookService.getById(input.isbn);');
    expect(codeOf(books, 'update')).toContain(
      'return await BookService.update(input.isbn, input.data);'
    );
    expect(codeOf(books, 'delete')).toContain('return await BookService.delete(input.isbn);');
  });

  it('composes a composite key as one argument per key column, in key order', () => {
    expect(codeOf(memberships, 'get')).toContain(
      '.input(z.object({ orgId: z.number(), userId: z.string() }))'
    );
    expect(codeOf(memberships, 'get')).toContain(
      'return await MembershipService.getById(input.orgId, input.userId);'
    );
    expect(codeOf(memberships, 'update')).toContain(
      'return await MembershipService.update(input.orgId, input.userId, input.data);'
    );
  });

  it('passes the injected handle ahead of the key', () => {
    expect(codeOf(memberships, 'get', true)).toContain(
      'return await MembershipService.getById(context.db, input.orgId, input.userId);'
    );
    expect(codeOf(memberships, 'update', true)).toContain(
      'return await MembershipService.update(context.db, input.orgId, input.userId, input.data);'
    );
  });
});

describe('a table with no primary key', () => {
  it('emits list and create only, matching the service it calls', () => {
    const names = hooks.procedures(logs).map((p) => p.name);
    expect(names).toEqual(['list', 'create']);
  });

  it('reads a hand-built { name, tsName } table as keyless rather than inventing an id', () => {
    const names = hooks.procedures({ name: 'users', tsName: 'users' } as never).map((p) => p.name);
    expect(names).toEqual(['list', 'create']);
  });
});

describe('a key column DRZL cannot type', () => {
  it('stubs the addressing procedures and says why', () => {
    const get = codeOf(ledgers, 'get');
    expect(get).toContain('.input(z.object({ seq: z.unknown() }))');
    expect(get).not.toContain('LedgerService.getById');
    expect(get).toContain('DRZL cannot type its column seq');
    expect(get).toMatch(/throw new Error\('Not implemented: get ledgers\.'\)/);
    expect(codeOf(ledgers, 'update')).not.toContain('LedgerService.update');
    expect(codeOf(ledgers, 'delete')).not.toContain('LedgerService.delete');
  });

  it('keeps list and create wired: only the key was untypeable', () => {
    expect(codeOf(ledgers, 'list')).toContain('return await LedgerService.getAll();');
    expect(codeOf(ledgers, 'create')).toContain('return await LedgerService.create(input);');
  });
});
