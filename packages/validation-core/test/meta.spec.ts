/**
 * The facts a generated schema can carry beside itself.
 *
 * The rule every key here is chosen by: a key earns its bytes only if it says something the
 * emitted schema does not already say. Two ways it can qualify.
 *
 *   the schema never knew it    the SQL type, the primary key, the unique constraints, the
 *                               dialect, whether the database generates or defaults the value.
 *   the schema enforces it and  a `varchar(255)` limit and every CHECK are `.refine()` calls in
 *   cannot show it              zod, and `z.toJSONSchema` drops a refinement silently. So a
 *                               JSON Schema built from the emitted module is wrong by omission
 *                               and nothing in it says so.
 *
 * Nullability is the counter-example and is deliberately absent: `.nullable()` is in the schema
 * and `anyOf: [..., { type: 'null' }]` is in its JSON Schema, so a `nullable` key would be a
 * second copy of an answer the consumer already has.
 */
import { describe, it, expect } from 'vitest';
import type { Column, Table } from '@drzl/analyzer';
import { columnMetaFacts, tableMetaFacts } from '../src/meta';

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

const table = (over: Partial<Table> = {}): Table =>
  ({
    name: 't',
    tsName: 't',
    columns: [],
    unique: [],
    indexes: [],
    checks: [],
    ...over,
  }) as Table;

describe('a column', () => {
  it('carries the declared SQL type, which no schema can state', () => {
    expect(columnMetaFacts(col('a', { sqlType: 'varchar(255)' }), table(), {})).toEqual({
      sqlType: 'varchar(255)',
    });
  });

  it('says nothing about nullability, which the schema already says', () => {
    const facts = columnMetaFacts(col('a', { sqlType: 'text', nullable: true }), table(), {});
    expect(Object.keys(facts)).toEqual(['sqlType']);
  });

  it('carries a width that lives inside a closure in the emitted schema', () => {
    // `.refine((v) => [...v].length <= 255)` is the emitted form, and both the number and the
    // fact that there is a limit are invisible to every reader of the schema object.
    expect(
      columnMetaFacts(col('a', { sqlType: 'varchar(255)', maxLength: 255 }), table(), {})
    ).toEqual({ sqlType: 'varchar(255)', maxLength: 255 });
    expect(columnMetaFacts(col('a', { sqlType: 'tinytext', maxBytes: 255 }), table(), {})).toEqual({
      sqlType: 'tinytext',
      maxBytes: 255,
    });
  });

  it('separates a database default from a nullable column, which .optional() cannot', () => {
    // Both are `.optional()` on insert, so the wrapper alone cannot say which one it is.
    const withDefault = columnMetaFacts(col('a', { hasDefault: true }), table(), {});
    const nullable = columnMetaFacts(col('a', { nullable: true }), table(), {});
    expect(withDefault).toEqual({ hasDefault: true });
    expect(nullable).toEqual({});
  });

  it('marks a generated column, which is simply absent from the write schemas', () => {
    expect(columnMetaFacts(col('a', { isGenerated: true, hasDefault: true }), table(), {})).toEqual(
      {
        hasDefault: true,
        generated: true,
      }
    );
  });

  it('names the CHECK constraints that apply to it', () => {
    const age = col('age', { tsType: 'number' });
    const t = table({ columns: [age], checks: [{ name: 'adult', expression: 'age >= 18' }] });
    expect(columnMetaFacts(age, t, {})).toEqual({ checks: ['adult: age >= 18'] });
  });

  it('names a length and a set constraint too, in the same spelling the messages use', () => {
    const a = col('a');
    const t = table({
      columns: [a],
      checks: [{ name: 'short', expression: 'length(a) <= 5' }, { expression: "a IN ('x', 'y')" }],
    });
    expect(columnMetaFacts(a, t, {}).checks).toEqual(['short: length(a) <= 5', "a IN ('x', 'y')"]);
  });

  it('reports a constraint its own shape refuses as enforced nowhere', () => {
    // `CHECK (tags = '{}')` compares an array to a scalar. Every generator skips it, because
    // `.refine((v) => v === '{}')` against a `string[]` rejects every row. Silently attributing it
    // to the field would say the schema checks something no value can pass.
    const tags = col('tags', { arrayDimensions: 1 });
    const t = table({ columns: [tags], checks: [{ name: 'empty', expression: "tags = '{}'" }] });
    expect(columnMetaFacts(tags, t, {}).checks).toBeUndefined();
    expect(tableMetaFacts(t, { mode: 'select' }).unenforcedChecks).toEqual(["empty: tags = '{}'"]);
  });

  it('leaves a constraint about another column alone', () => {
    const age = col('age', { tsType: 'number' });
    const name = col('name');
    const t = table({
      columns: [age, name],
      checks: [{ name: 'adult', expression: 'age >= 18' }],
    });
    expect(columnMetaFacts(name, t, {})).toEqual({});
  });

  it('writes a description only when asked, and only from what the schema cannot show', () => {
    const c = col('age', { tsType: 'number', sqlType: 'integer' });
    const t = table({ columns: [c], checks: [{ name: 'adult', expression: 'age >= 18' }] });
    expect(columnMetaFacts(c, t, {}).description).toBeUndefined();
    expect(columnMetaFacts(c, t, { description: true }).description).toBe('CHECK adult: age >= 18');
  });

  it('has no description when there is nothing the schema failed to show', () => {
    const facts = columnMetaFacts(col('a', { sqlType: 'text' }), table(), { description: true });
    expect(facts.description).toBeUndefined();
  });
});

describe('a table', () => {
  it('carries the SQL name, the dialect and the mode', () => {
    const facts = tableMetaFacts(table({ name: 'user_accounts', tsName: 'userAccounts' }), {
      mode: 'select',
      dialect: 'postgres',
    });
    expect(facts).toMatchObject({ table: 'user_accounts', dialect: 'postgres', mode: 'select' });
  });

  it('carries the primary key in order, which a per-field flag cannot', () => {
    const facts = tableMetaFacts(table({ primaryKey: { columns: ['tenant', 'id'] } }), {
      mode: 'select',
    });
    expect(facts.primaryKey).toEqual(['tenant', 'id']);
  });

  it('carries the unique constraints, the one thing a per-row schema structurally cannot see', () => {
    const facts = tableMetaFacts(
      table({ unique: [{ columns: ['email'] }, { name: 'org_slug', columns: ['org', 'slug'] }] }),
      { mode: 'insert' }
    );
    expect(facts.unique).toEqual([['email'], ['org', 'slug']]);
  });

  it('marks a relation that refuses writes', () => {
    expect(tableMetaFacts(table({ readOnly: true }), { mode: 'select' }).readOnly).toBe(true);
    expect(tableMetaFacts(table(), { mode: 'select' }).readOnly).toBeUndefined();
  });

  it('carries the row-level CHECKs, which are object refinements and so invisible', () => {
    const facts = tableMetaFacts(
      table({
        columns: [col('start_date'), col('end_date')],
        checks: [{ name: 'order', expression: 'start_date < end_date' }],
      }),
      { mode: 'select' }
    );
    expect(facts.checks).toEqual(['order: start_date < end_date']);
  });

  it('names the CHECKs it declined to translate, which appear nowhere else at all', () => {
    // A parsed check becomes a `.refine()` a reader can at least find. A declined one is dropped
    // in silence, and `drzl doctor` is the only thing that mentions it.
    const facts = tableMetaFacts(
      table({ checks: [{ name: 'weird', expression: 'my_fn(a) > now()' }] }),
      { mode: 'select' }
    );
    expect(facts.unenforcedChecks).toEqual(['weird: my_fn(a) > now()']);
    expect(facts.checks).toBeUndefined();
  });

  it('writes a description only when asked', () => {
    const t = table({
      columns: [col('lo'), col('hi')],
      checks: [
        { name: 'order', expression: 'lo < hi' },
        { name: 'weird', expression: 'my_fn(a) > now()' },
      ],
    });
    expect(tableMetaFacts(t, { mode: 'select' }).description).toBeUndefined();
    const d = tableMetaFacts(t, { mode: 'select', description: true }).description;
    expect(d).toContain('CHECK order: lo < hi');
    expect(d).toContain('not enforced');
    expect(d).toContain('my_fn(a) > now()');
  });
});
