/**
 * The addressing inputs, typed from the primary key instead of the hardcoded
 * `z.object({ id: z.number() })` this template spelled for every table (plan addendum BQ).
 *
 * The generator rewrites these inputs into the configured validation library before emission,
 * so what these procedures spell matters to direct consumers of the hooks; the drop of
 * get/update/delete for a keyless table matters to everyone, because a procedure addressing a
 * row that cannot be addressed is fiction whatever the body does.
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

const codeOf = (table: never, name: string) =>
  hooks.procedures(table).find((p) => p.name === name)?.code;

describe('key-typed inputs', () => {
  it('keeps the integer key byte for byte', () => {
    expect(codeOf(users, 'get')).toContain('os.input(z.object({ id: z.number() }))');
    expect(codeOf(users, 'update')).toContain(
      'os.input(z.object({ id: z.number(), data: z.any() }))'
    );
    expect(codeOf(users, 'delete')).toContain('os.input(z.object({ id: z.number() }))');
  });

  it('types a natural key as the string it is', () => {
    expect(codeOf(books, 'get')).toContain('os.input(z.object({ isbn: z.string() }))');
    expect(codeOf(books, 'update')).toContain(
      'os.input(z.object({ isbn: z.string(), data: z.any() }))'
    );
  });

  it('keeps every column of a composite key, in key order', () => {
    expect(codeOf(memberships, 'get')).toContain(
      'os.input(z.object({ orgId: z.number(), userId: z.string() }))'
    );
  });
});

describe('a table with no primary key', () => {
  it('emits list and create only', () => {
    expect(hooks.procedures(logs).map((p) => p.name)).toEqual(['list', 'create']);
  });

  it('reads a hand-built { name, tsName } table as keyless rather than inventing an id', () => {
    expect(hooks.procedures({ name: 'users', tsName: 'users' } as never).map((p) => p.name)).toEqual(
      ['list', 'create']
    );
  });
});
