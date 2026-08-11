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

/**
 * A key the analyzer really cannot type: a `customType` with no `$type<T>()`, which it reports as
 * `unknown`. `ledgers` used to stand for this case, on the strength of `bigint` having no JSON
 * transport, and stopped being an example of it when bigint gained one.
 */
const opaque = {
  name: 'opaque',
  tsName: 'opaque',
  columns: [col('handle', 'unknown'), col('label', 'string')],
  primaryKey: { columns: ['handle'] },
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

describe('a bigint key, which crosses as digits', () => {
  it('is wired, because the wire form converts back exactly', () => {
    // This table used to stand for "DRZL cannot type this key". It does not any more: a bigint
    // travels as its decimal digits, the input schema pins them, and `BigInt()` on a string the
    // pattern admitted is total. The service parameter is a real bigint, so the call is written.
    const get = codeOf(ledgers, 'get');
    expect(get).toContain(String.raw`.input(z.object({ seq: z.string().regex(/^-?\d+$/) }))`);
    expect(get).toContain('return await LedgerService.getById(BigInt(input.seq));');
    expect(get).not.toContain('Not implemented');
  });

  it('converts on update and delete too, not only on the read', () => {
    expect(codeOf(ledgers, 'update')).toContain(
      'return await LedgerService.update(BigInt(input.seq), input.data);'
    );
    expect(codeOf(ledgers, 'delete')).toContain(
      'return await LedgerService.delete(BigInt(input.seq));'
    );
  });
});

describe('a key column DRZL cannot type', () => {
  it('stubs the addressing procedures and says why', () => {
    const get = codeOf(opaque, 'get');
    expect(get).toContain('.input(z.object({ handle: z.unknown() }))');
    expect(get).not.toContain('OpaqueService.getById');
    expect(get).toContain('DRZL cannot type its column handle');
    expect(get).toMatch(/throw new Error\('Not implemented: get opaque\.'\)/);
    expect(codeOf(opaque, 'update')).not.toContain('OpaqueService.update');
    expect(codeOf(opaque, 'delete')).not.toContain('OpaqueService.delete');
  });

  it('keeps list and create wired: only the key was untypeable', () => {
    expect(codeOf(opaque, 'list')).toContain('return await OpaqueService.getAll();');
    expect(codeOf(opaque, 'create')).toContain('return await OpaqueService.create(input);');
  });
});
