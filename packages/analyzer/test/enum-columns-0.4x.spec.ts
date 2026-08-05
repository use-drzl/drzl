/**
 * An enum column's type on drizzle-orm 0.4x, where the class name is all there is to go on.
 *
 * 0.4x gives an enum its own column class and states no `codec`, so the class-name map is the only
 * path. It had an arm for `PgEnumColumn` and none for the MySQL or SingleStore classes, so those
 * columns came back `tsType: 'unknown'` while carrying a full `enumValues` array.
 *
 * The emitted validator was never wrong. Every generator reads `enumValues` before it reads
 * `tsType`, so a MySQL enum column has always produced a real three-member enum. What was wrong was
 * the description, and the description reached the user anyway through the untyped-column warning:
 *
 *   Column "m_enum" on table "t" has no known type (SQL type enum('a','b','c')),
 *   so its validator will accept any value.
 *
 * Measured on the emitted schema, it accepted exactly three. A warning that is wrong about the one
 * column it names teaches the reader to skip the true ones, which is the whole cost of this defect.
 *
 * `string` rather than a union of the values, because that is what v1 answers for the same column
 * and the narrowing lives in `enumValues` on both majors. Checked rather than assumed: on
 * 1.0.0-rc.4 the same table gives `tsType: 'string'`, `enumValues: ['a','b','c']` and no issues.
 */
import { describe, it, expect } from 'vitest';
import { SchemaAnalyzer } from '../src/index';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function analyzed(source: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-enum-'));
  const file = path.join(dir, 'schema.mjs');
  await fs.writeFile(file, source, 'utf8');
  return new SchemaAnalyzer(file).analyze();
}

const MYSQL = `
import { mysqlTable, mysqlEnum, varchar, int } from 'drizzle-orm/mysql-core';
export const t = mysqlTable('t', {
  id: int('id').primaryKey(),
  m_enum: mysqlEnum('m_enum', ['a', 'b', 'c']).notNull(),
  name: varchar('name', { length: 10 }).notNull(),
});
`;

const SINGLESTORE = `
import { singlestoreTable, singlestoreEnum, int } from 'drizzle-orm/singlestore-core';
export const t = singlestoreTable('t', {
  id: int('id').primaryKey(),
  s_enum: singlestoreEnum('s_enum', ['x', 'y']).notNull(),
});
`;

describe('an enum column on drizzle-orm 0.4x', () => {
  it('is a string carrying its values, on MySQL', async () => {
    const res = await analyzed(MYSQL);
    const col = res.tables[0].columns.find((c) => c.name === 'm_enum');
    expect(col?.tsType).toBe('string');
    expect(col?.enumValues).toEqual(['a', 'b', 'c']);
  });

  it('is a string carrying its values, on SingleStore', async () => {
    const res = await analyzed(SINGLESTORE);
    const col = res.tables[0].columns.find((c) => c.name === 's_enum');
    expect(col?.tsType).toBe('string');
    expect(col?.enumValues).toEqual(['x', 'y']);
  });

  it('raises no untyped-column warning, because the validator does not accept any value', async () => {
    const res = await analyzed(MYSQL);
    const warned = res.issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN');
    expect(warned.map((i) => i.message)).toEqual([]);
  });

  // The control. The warning still has to fire where it is true, or this fix has traded a false
  // positive for a false negative, which is the worse of the two: nothing then reports a column
  // whose validator really does take anything.
  it('still warns for a column it genuinely cannot name', async () => {
    const res = await analyzed(`
      import { customType, mysqlTable, int } from 'drizzle-orm/mysql-core';
      const opaque = customType({ dataType: () => 'geometry' });
      export const t = mysqlTable('t', {
        id: int('id').primaryKey(),
        blob: opaque('blob').notNull(),
      });
    `);
    const warned = res.issues.filter((i) => i.code === 'DRZL_ANL_UNKNOWN_COLUMN');
    expect(warned.length).toBe(1);
    expect(warned[0].message).toContain('"blob"');
  });
});
