/**
 * Relations v2, from `defineRelations(schema, (r) => ...)`.
 *
 * Drizzle v1 added a second way to declare relations, and the analyzer only knew the first. A
 * schema using the new API produced an empty relations array, so the oRPC and service generators
 * emitted no relation endpoints at all. Nothing failed: the output was simply missing.
 *
 * Verified against drizzle-orm 1.0.0-rc.4, where `@drzl/cli@4.8.0` returns `[]` for the same
 * schema this reader now reads. The shapes below were taken from a real `defineRelations` result
 * rather than invented, and `scripts/verify-packed.sh` re-runs the real thing.
 */
import { describe, it, expect } from 'vitest';
import { isRelationsV2, readRelationsV2 } from '../src/index';

/** A table as Drizzle presents one, identified by the name symbol the reader looks for. */
const table = (name: string) => ({ [Symbol.for('drizzle:Name')]: name });

/** One entry of a `defineRelations` result. */
const entry = (name: string, relations: Record<string, unknown>) => ({
  table: table(name),
  name,
  relations,
});

const one = (targetTableName: string) => ({ relationType: 'one', targetTableName });
const many = (targetTableName: string, throughTable?: string) => ({
  relationType: 'many',
  targetTableName,
  ...(throughTable ? { throughTable: table(throughTable) } : {}),
});

describe('recognising the shape', () => {
  it('accepts a defineRelations result', () => {
    const v2 = { authors: entry('authors', { books: many('books') }) };
    expect(isRelationsV2(v2)).toBe(true);
  });

  it('rejects things that are not one', () => {
    // v2 has no marker class or symbol, so the shape is what identifies it, and the check has to
    // be specific enough not to swallow a table or an enum.
    expect(isRelationsV2(null)).toBe(false);
    expect(isRelationsV2({})).toBe(false);
    expect(isRelationsV2([entry('a', {})])).toBe(false);
    expect(isRelationsV2({ a: { table: table('a') } }), 'no relations key').toBe(false);
    expect(
      isRelationsV2({ a: entry('a', { x: { targetTableName: 'b' } }) }),
      'no relationType'
    ).toBe(false);
  });
});

describe('reading the relations', () => {
  it('reads both directions of a one-to-many', () => {
    const v2 = {
      authors: entry('authors', { books: many('books') }),
      books: entry('books', { author: one('authors') }),
    };
    expect(readRelationsV2(v2)).toEqual([
      { kind: 'many', from: 'authors', to: 'books' },
      { kind: 'one', from: 'books', to: 'authors' },
    ]);
  });

  it('takes the join table of a many-to-many from `through` rather than guessing', () => {
    // The v1 path infers a join table with a heuristic over tables whose columns are all foreign
    // keys. v2 states it outright, so a join table carrying extra columns is still recognised.
    const v2 = {
      users: entry('users', { groups: many('groups', 'memberships') }),
    };
    expect(readRelationsV2(v2)).toEqual([
      { kind: 'manyToMany', from: 'users', to: 'groups', via: 'memberships' },
    ]);
  });

  it('falls back to the entry name when the table carries no name symbol', () => {
    const v2 = { posts: { table: {}, name: 'posts', relations: { author: one('users') } } };
    expect(readRelationsV2(v2)).toEqual([{ kind: 'one', from: 'posts', to: 'users' }]);
  });

  it('skips a relation with no target and says so, rather than emitting a broken one', () => {
    const issues: any[] = [];
    const v2 = { a: entry('a', { bad: { relationType: 'one' }, good: one('b') }) };
    expect(readRelationsV2(v2, issues)).toEqual([{ kind: 'one', from: 'a', to: 'b' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('DRZL_ANL_REL_V2');
    expect(issues[0].message).toMatch(/bad/);
  });
});
