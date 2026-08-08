/**
 * `CHECK (col IS NOT NULL)`, which narrows a field rather than adding a predicate to it.
 *
 * Every other CHECK this parser reads sits *inside* the nullable wrapper, because SQL applies a
 * comparison only to a value that is there and a CHECK passes on NULL. This one is the exception:
 * it is the constraint that says NULL is not allowed, so the only place it can live is the
 * wrapper itself. It is applied here, in the three functions every generator asks for its column
 * list, so no generator has to know about it and none of the five can disagree with the others.
 *
 * Verified against a real Postgres: a nullable column carrying this constraint refuses NULL on
 * insert and refuses `SET col = NULL` on update, and a row omitting the column is refused too
 * unless the column defaults to something that is not NULL.
 */
import { describe, expect, it } from 'vitest';
import type { Column, Table } from '@drzl/analyzer';
import { insertColumns, selectColumns, updateColumns } from '../src/index';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: true,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

const table = (cols: Column[], checks: { name?: string; expression?: string }[] = []): Table =>
  ({ name: 't', tsName: 't', columns: cols, unique: [], indexes: [], checks }) as Table;

const nullableOf = (cols: Column[], name: string) => cols.find((c) => c.name === name)!.nullable;

describe('a CHECK that forbids NULL', () => {
  const t = () =>
    table([col('email'), col('note')], [{ name: 'email_set', expression: 'email IS NOT NULL' }]);

  it('makes the column not nullable in every mode', () => {
    for (const pick of [insertColumns, updateColumns, selectColumns]) {
      expect(nullableOf(pick(t()), 'email'), pick.name).toBe(false);
    }
  });

  it('leaves every other column exactly as it was', () => {
    expect(nullableOf(selectColumns(t()), 'note')).toBe(true);
  });

  it('does not mutate the analysis it was handed', () => {
    // The generators read `table.columns` for other things, and a shared object edited in place
    // would make the answer depend on which generator ran first.
    const analysed = t();
    insertColumns(analysed);
    expect(analysed.columns.find((c) => c.name === 'email')!.nullable).toBe(true);
  });

  it('reads the constraint out of a conjunction and a null guard alike', () => {
    const both = table([col('email')], [{ expression: "email IS NOT NULL AND email <> ''" }]);
    expect(nullableOf(selectColumns(both), 'email')).toBe(false);
  });

  it('is not claimed by IS NULL, which narrows nothing', () => {
    const t2 = table([col('email')], [{ expression: 'email IS NULL' }]);
    expect(nullableOf(selectColumns(t2), 'email')).toBe(true);
  });

  it('is not claimed by a null guard, whose IS NULL branch is dropped', () => {
    // `email IS NULL OR length(email) > 3` reduces to the length bound and says nothing about
    // nullability. Reading a narrowing out of it would refuse every NULL the database takes.
    const t2 = table([col('email')], [{ expression: 'email IS NULL OR length(email) > 3' }]);
    expect(nullableOf(selectColumns(t2), 'email')).toBe(true);
  });

  it('is ignored when the constraint as a whole was not understood', () => {
    const t2 = table([col('email')], [{ expression: 'email IS NOT NULL OR my_fn(email) > 1' }]);
    expect(nullableOf(selectColumns(t2), 'email')).toBe(true);
  });

  it('names a column the table does not have without disturbing the others', () => {
    const t2 = table([col('email')], [{ expression: 'nowhere IS NOT NULL' }]);
    expect(selectColumns(t2).map((c) => c.name)).toEqual(['email']);
    expect(nullableOf(selectColumns(t2), 'email')).toBe(true);
  });

  it('costs nothing on a table with no such constraint', () => {
    // Same array identity, so the common path allocates nothing.
    const plain = table([col('a')], [{ expression: "a <> 'x'" }]);
    expect(selectColumns(plain)[0]).toBe(plain.columns[0]);
  });

  it('leaves a column already declared NOT NULL exactly as it was', () => {
    const t2 = table([col('email', { nullable: false })], [{ expression: 'email IS NOT NULL' }]);
    expect(selectColumns(t2)[0]).toBe(t2.columns[0]);
  });
});
