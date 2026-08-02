/**
 * Which columns belong in an insert schema.
 *
 * `isGeneratedColumn` used to answer `c.isGenerated || primaryKeyColumns.includes(c.name)`, so
 * every primary key was dropped whether or not the database supplied it. That is right for a
 * MySQL autoincrement column and wrong for a Postgres `integer('id').primaryKey()`, which
 * Postgres does not generate, and for any natural key such as `text('slug').primaryKey()`. The
 * resulting schema could not express a valid insert at all: the required column was simply
 * absent, with no way to provide it.
 *
 * Primary-key-ness is not the question. The question is whether the database supplies a value,
 * which `isGenerated` answers for columns that cannot be written and `hasDefault` answers for
 * columns that need not be. A defaulted column stays in the schema and is marked optional by the
 * generators, so a caller may supply it or leave it out.
 */
import { describe, it, expect } from 'vitest';
import { insertColumns, isGeneratedColumn, updateColumns, selectColumns } from '../src/index';
import type { Table } from '../src/index';
// `Column` is the analyzer's type; validation-core consumes it without re-exporting.
import type { Column } from '@drzl/analyzer';

const col = (name: string, extra: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...extra,
  }) as Column;

const table = (columns: Column[], pk: string[]): Table =>
  ({ name: 't', tsName: 't', columns, primaryKey: { columns: pk } }) as Table;

describe('insertColumns', () => {
  it('keeps a natural primary key, which the caller has to supply', () => {
    const t = table([col('slug'), col('title')], ['slug']);
    expect(insertColumns(t).map((c) => c.name)).toEqual(['slug', 'title']);
  });

  it('keeps an undefaulted integer primary key, as Postgres does not generate one', () => {
    const t = table([col('id', { tsType: 'number' }), col('email')], ['id']);
    expect(insertColumns(t).map((c) => c.name)).toContain('id');
  });

  it('drops a generated primary key, which cannot be written', () => {
    const t = table([col('id', { isGenerated: true, hasDefault: true }), col('email')], ['id']);
    expect(insertColumns(t).map((c) => c.name)).toEqual(['email']);
  });

  it('keeps a defaulted primary key so it can be supplied or omitted', () => {
    // A serial or rowid key. The generators mark a defaulted column optional, so keeping it
    // allows an explicit value without ever requiring one. Dropping it forbade both.
    const t = table([col('id', { tsType: 'number', hasDefault: true }), col('email')], ['id']);
    expect(insertColumns(t).map((c) => c.name)).toEqual(['id', 'email']);
  });

  it('drops a generated column that is not a primary key', () => {
    const t = table([col('id'), col('computed', { isGenerated: true })], ['id']);
    expect(insertColumns(t).map((c) => c.name)).toEqual(['id']);
  });

  it('keeps every column when nothing is generated', () => {
    const t = table([col('a'), col('b')], []);
    expect(insertColumns(t).map((c) => c.name)).toEqual(['a', 'b']);
  });
});

describe('isGeneratedColumn', () => {
  it('asks whether the column is generated, not whether it is a key', () => {
    expect(isGeneratedColumn(col('slug'), ['slug'])).toBe(false);
    expect(isGeneratedColumn(col('id', { isGenerated: true }), [])).toBe(true);
  });
});

describe('the other selections are unchanged', () => {
  it('updateColumns still excludes the primary key, which identifies rather than changes', () => {
    const t = table([col('id'), col('email')], ['id']);
    expect(updateColumns(t).map((c) => c.name)).toEqual(['email']);
  });

  it('selectColumns still returns every column', () => {
    const t = table([col('id', { isGenerated: true }), col('email')], ['id']);
    expect(selectColumns(t).map((c) => c.name)).toEqual(['id', 'email']);
  });
});
