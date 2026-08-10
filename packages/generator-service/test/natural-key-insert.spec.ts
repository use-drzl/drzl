/**
 * A natural primary key in the generated service types.
 *
 * `Insert<T>` excluded every primary key column, which is right for a key the server supplies and
 * wrong for one it does not. A `books` table keyed by `isbn` had no way to carry its own isbn, so
 * the one value that addresses the row had nowhere to come from and no insert could be expressed
 * at all.
 *
 * Being a primary key is not what makes a column omissible; being one the database can fill in is.
 * So the condition reads the column rather than the key, which also means a `serial` or identity
 * key emits exactly the bytes it did before: that half is asserted here too, because a fix that
 * moves the common case while fixing the rare one is a different change from the one intended.
 *
 * The update type is untouched. A patch that re-keys a row is a different operation, and the key
 * comes from the `id` argument beside the patch.
 */
import { describe, it, expect } from 'vitest';
import { ServiceGenerator } from '../src';
import type { Analysis, Column, Table } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

const table = (name: string, columns: Column[], pk: string[]): Table =>
  ({ name, tsName: name, columns, primaryKey: { columns: pk }, unique: [], indexes: [] }) as never;

/** Keyed by its isbn, which nothing but the caller can supply. */
const books = table('books', [col('isbn'), col('title')], ['isbn']);

/** Keyed by a serial, which the server supplies. */
const users = table(
  'users',
  [col('id', { tsType: 'number', dbType: 'INTEGER', hasDefault: true, isGenerated: true }), col('email')],
  ['id']
);

/** A composite natural key, since one column being natural is not the same as two. */
const memberships = table(
  'memberships',
  [
    col('orgId', { tsType: 'number', dbType: 'INTEGER' }),
    col('userId', { tsType: 'number', dbType: 'INTEGER' }),
    col('role'),
  ],
  ['orgId', 'userId']
);

async function emit(tables: Table[]): Promise<Record<string, string>> {
  const analysis: Analysis = { dialect: 'postgres', tables, enums: [], relations: [], issues: [] };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-natural-key-'));
  await new ServiceGenerator(analysis).generate({ outDir: dir } as never);
  const out: Record<string, string> = {};
  const walk = async (d: string): Promise<void> => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else out[entry.name] = await fs.readFile(p, 'utf8');
    }
  };
  await walk(dir);
  return out;
}

/** The body of one declaration, so an assertion cannot drift into the next one. */
const block = (src: string, decl: string): string => {
  const at = src.indexOf(decl);
  expect(at, `${decl} is not in the emitted module`).toBeGreaterThan(-1);
  return src.slice(at, src.indexOf('}', at) + 1);
};

describe('a natural primary key', () => {
  it('is carried by the insert type, because nothing else can supply it', async () => {
    const files = await emit([books]);
    const insert = block(files['books.ts']!, 'interface Insertbooks');
    expect(insert).toContain('isbn: string;');
    // Required, not optional: a row with no isbn is a row the database refuses.
    expect(insert).not.toContain('isbn?:');
  });

  it('is carried for every column of a composite one', async () => {
    const files = await emit([memberships]);
    const insert = block(files['memberships.ts']!, 'interface Insertmemberships');
    expect(insert).toContain('orgId: number;');
    expect(insert).toContain('userId: number;');
  });

  it('stays out of the update type, where re-keying is a different operation', async () => {
    const files = await emit([books]);
    const update = block(files['books.ts']!, 'interface Updatebooks');
    expect(update).not.toContain('isbn');
    expect(update).toContain('title?:');
  });
});

describe('a key the server supplies', () => {
  it('is still absent from the insert type', async () => {
    const files = await emit([users]);
    const insert = block(files['users.ts']!, 'interface Insertusers');
    expect(insert).not.toContain('id');
    expect(insert).toContain('email: string;');
  });
});
