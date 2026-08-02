/**
 * A table-level `unique()` constraint, which was being read as the primary key.
 *
 * The extra-config callback returns builders that are told apart by shape. An index builder keeps
 * its data under `config` and carries a `unique` flag; a primary key builder keeps `columns`
 * directly on the instance. The rule was "no `unique` flag means it is the primary key", and a
 * `UniqueConstraintBuilder` also keeps `columns` directly on the instance and also has no
 * `unique` flag, so it matched.
 *
 * The result was not a missing constraint but a wrong one: `unique('org_handle').on(org, handle)`
 * replaced the table's primary key, so a table keyed on `id` reported a composite key on
 * `['org', 'handle']`. The service and router generators build lookups from that.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '../src/index';

const dir = path.resolve(__dirname, 'fixtures');

async function tableOf(name: string, source: string) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  await fs.writeFile(file, source, 'utf8');
  const a = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
  return a.tables[0]!;
}

const DIALECTS = {
  postgres: { mod: 'pg-core', table: 'pgTable', text: 'text', int: 'integer' },
  mysql: { mod: 'mysql-core', table: 'mysqlTable', text: 'text', int: 'int' },
  sqlite: { mod: 'sqlite-core', table: 'sqliteTable', text: 'text', int: 'integer' },
};

describe.each(Object.entries(DIALECTS))('%s', (dialect, d) => {
  it('records a table-level unique as unique, and leaves the primary key alone', async () => {
    const t = await tableOf(
      `tbl-unique-${dialect}`,
      `
      import { ${d.table}, ${d.text}, ${d.int}, unique } from 'drizzle-orm/${d.mod}';
      export const users = ${d.table}('users', {
        id: ${d.int}('id').primaryKey(),
        org: ${d.text}('org').notNull(),
        handle: ${d.text}('handle').notNull(),
      }, (t) => [unique('org_handle').on(t.org, t.handle)]);
      `
    );
    expect(t.unique).toEqual([{ columns: ['org', 'handle'], name: 'org_handle' }]);
    expect(t.primaryKey?.columns, 'the unique must not become the primary key').not.toEqual([
      'org',
      'handle',
    ]);
  });

  it('still reads a real composite primary key', async () => {
    const t = await tableOf(
      `tbl-pk-${dialect}`,
      `
      import { ${d.table}, ${d.text}, primaryKey } from 'drizzle-orm/${d.mod}';
      export const t = ${d.table}('t', {
        a: ${d.text}('a').notNull(),
        b: ${d.text}('b').notNull(),
      }, (x) => [primaryKey({ columns: [x.a, x.b] })]);
      `
    );
    expect(t.primaryKey?.columns).toEqual(['a', 'b']);
  });

  it('reads both at once without either eating the other', async () => {
    const t = await tableOf(
      `tbl-both-${dialect}`,
      `
      import { ${d.table}, ${d.text}, unique, primaryKey } from 'drizzle-orm/${d.mod}';
      export const t = ${d.table}('t', {
        a: ${d.text}('a').notNull(),
        b: ${d.text}('b').notNull(),
        c: ${d.text}('c').notNull(),
      }, (x) => [primaryKey({ columns: [x.a, x.b] }), unique('c_uq').on(x.c)]);
      `
    );
    expect(t.primaryKey?.columns).toEqual(['a', 'b']);
    expect(t.unique).toEqual([{ columns: ['c'], name: 'c_uq' }]);
  });
});
