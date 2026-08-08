/**
 * The batch duplicate finder, executed rather than string-matched.
 *
 * Uniqueness is the one constraint a per-row validator structurally cannot see. What is checkable
 * without a database is whether a batch collides with itself, which is the half a user can fix
 * before sending anything.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { renderDuplicateFinder } from '../src/duplicates';
import type { Table } from '@drzl/analyzer';

const table = (
  unique: Array<{ name?: string; columns: string[] }>,
  primaryKey?: { name?: string; columns: string[] }
): Table =>
  ({ name: 't', tsName: 't', columns: [], unique, primaryKey, indexes: [], checks: [] }) as never;

let seq = 0;

/** Write the emitted function to a module and import it, so the assertions run real code. */
async function finderFor(
  unique: Array<{ name?: string; columns: string[] }>,
  primaryKey?: { name?: string; columns: string[] }
) {
  const src = renderDuplicateFinder(table(unique, primaryKey), 'findDuplicates', 'Row');
  expect(src, 'nothing emitted').toBeTruthy();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-dup-'));
  const file = path.join(dir, `d${seq++}.ts`);
  await fs.writeFile(file, `type Row = Record<string, unknown>;\n${src}\n`, 'utf8');
  return (await import(file)).findDuplicates as (rows: unknown[]) => any[];
}

describe('a single-column unique constraint', () => {
  it('reports the later row and points at the first', async () => {
    const f = await finderFor([{ name: 'email_uq', columns: ['email'] }]);
    const out = f([{ email: 'a' }, { email: 'b' }, { email: 'a' }]);
    expect(out).toEqual([{ index: 2, constraint: 'email_uq', firstIndex: 0 }]);
  });

  it('says nothing when the batch is clean', async () => {
    const f = await finderFor([{ columns: ['email'] }]);
    expect(f([{ email: 'a' }, { email: 'b' }])).toEqual([]);
  });

  it('reports every repeat, not just the second', async () => {
    const f = await finderFor([{ name: 'u', columns: ['x'] }]);
    expect(f([{ x: 1 }, { x: 1 }, { x: 1 }]).map((d) => d.index)).toEqual([1, 2]);
  });
});

describe('a composite unique constraint', () => {
  it('collides only when every column matches', async () => {
    const f = await finderFor([{ name: 'pair', columns: ['a', 'b'] }]);
    const out = f([
      { a: 1, b: 1 },
      { a: 1, b: 2 },
      { a: 2, b: 1 },
      { a: 1, b: 1 },
    ]);
    expect(out).toEqual([{ index: 3, constraint: 'pair', firstIndex: 0 }]);
  });

  it('does not confuse a number with the same digits as a string', async () => {
    // A key joined on a separator would collide these. JSON does not.
    const f = await finderFor([{ name: 'pair', columns: ['a', 'b'] }]);
    expect(f([{ a: 1, b: '2' }, { a: '1', b: 2 }])).toEqual([]);
  });
});

describe('null, which SQL treats as never equal to itself', () => {
  it('permits repeats where a column is null', async () => {
    // A unique index accepts any number of NULLs, because NULL = NULL is unknown. A finder that
    // reported these would send people chasing rows the database is perfectly happy with.
    const f = await finderFor([{ name: 'u', columns: ['x'] }]);
    expect(f([{ x: null }, { x: null }])).toEqual([]);
  });

  it('permits repeats where a column is absent', async () => {
    const f = await finderFor([{ name: 'u', columns: ['x'] }]);
    expect(f([{}, {}])).toEqual([]);
  });

  it('skips a composite constraint when any part is null', async () => {
    const f = await finderFor([{ name: 'pair', columns: ['a', 'b'] }]);
    expect(f([{ a: 1, b: null }, { a: 1, b: null }])).toEqual([]);
  });
});

describe('several constraints at once', () => {
  it('reports each independently', async () => {
    const f = await finderFor([
      { name: 'by_email', columns: ['email'] },
      { name: 'by_handle', columns: ['handle'] },
    ]);
    const out = f([
      { email: 'a', handle: 'h1' },
      { email: 'a', handle: 'h2' },
      { email: 'b', handle: 'h1' },
    ]);
    expect(out).toEqual([
      { index: 1, constraint: 'by_email', firstIndex: 0 },
      { index: 2, constraint: 'by_handle', firstIndex: 0 },
    ]);
  });
});

describe('the primary key, which the database enforces with a unique index', () => {
  // Measured against a real Postgres 17: two rows sharing an explicit key fail the insert with
  // `duplicate key value violates unique constraint "skus_pkey"` (23505). The database's own
  // error calls the primary key a unique constraint, so the finder covers it as one.
  it('is a constraint: a table with only a primary key gets a finder', async () => {
    const f = await finderFor([], { columns: ['code'] });
    const out = f([
      { code: 'A1', label: 'first' },
      { code: 'A1', label: 'second' },
    ]);
    expect(out).toEqual([{ index: 1, constraint: 't_pkey', firstIndex: 0 }]);
  });

  it('reports an explicit key collision even when every unique column differs', async () => {
    const f = await finderFor([{ name: 'email_uq', columns: ['email'] }], { columns: ['id'] });
    const out = f([
      { id: 7, email: 'a@x.co' },
      { id: 7, email: 'b@x.co' },
    ]);
    expect(out).toEqual([{ index: 1, constraint: 't_pkey', firstIndex: 0 }]);
  });

  it('stays silent for rows that leave the key to the database', async () => {
    // A serial or defaulted key is absent from seed rows; absence skips the constraint exactly
    // as it does for a unique key, so generated-key batches report nothing.
    const f = await finderFor([], { columns: ['id'] });
    expect(f([{ x: 1 }, { x: 1 }])).toEqual([]);
  });

  it('treats a composite key as one constraint', async () => {
    const f = await finderFor([], { columns: ['a', 'b'] });
    const out = f([
      { a: 1, b: 1 },
      { a: 1, b: 2 },
      { a: 1, b: 1 },
    ]);
    expect(out).toEqual([{ index: 2, constraint: 't_pkey', firstIndex: 0 }]);
  });

  it('uses the declared name when the analysis carries one', async () => {
    const f = await finderFor([], { name: 'sku_pk', columns: ['code'] });
    expect(f([{ code: 'x' }, { code: 'x' }])).toEqual([
      { index: 1, constraint: 'sku_pk', firstIndex: 0 },
    ]);
  });
});

describe('a table with no unique constraint and no primary key', () => {
  it('gets no function at all', () => {
    expect(renderDuplicateFinder(table([]), 'f', 'Row')).toBeUndefined();
    expect(renderDuplicateFinder(table([{ columns: [] }]), 'f', 'Row')).toBeUndefined();
    expect(renderDuplicateFinder(table([], { columns: [] }), 'f', 'Row')).toBeUndefined();
  });
});
