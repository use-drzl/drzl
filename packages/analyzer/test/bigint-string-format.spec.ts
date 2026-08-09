/**
 * The input syntax a `bigint({ mode: 'string' })` column really accepts, as a `format` the
 * generators can state, and the dialect split that decides which one.
 *
 * The defect: the arm PR #172 added types this column `string`/`BIGINT` and states nothing else,
 * so every generator emitted a bare string. Run against a real Postgres through PGlite with the
 * parity gate's own MATRIX_POOL, that schema disagreed with the server on 14 of the 36 values
 * (`''`, `'hello'`, a 300-character run, three and five emoji, `'12.5'`, a uuid, `'not-a-uuid'`,
 * `'happy'`, `'zzz'`, `'2020-01-01'`, `'12:00:00'`, `'10.0.0.1'`, `'999.999.999.999'`), on every
 * one of which Postgres refuses the insert and `drizzle-orm/zod` agrees with Postgres. A schema
 * that takes what the server will not is the thing an Insert schema exists to prevent.
 *
 * **Two patterns, because the two servers disagree in both directions.** Measured, Postgres 17
 * through PGlite and MySQL 8.4.11 in Docker, on a `bigint` column of each:
 *
 *   value      Postgres                     MySQL
 *   '0x1f'     stores 31                    refused, "Data truncated"
 *   '1_000'    stores 1000                  refused, "Data truncated"
 *   '12.5'     refused, "invalid input"     stores 13, rounded
 *   '1e3'      refused                      stores 1000
 *   '.5'       refused                      stores 1
 *
 * So no single pattern is right for both. The union of the two admits `'12.5'` on Postgres, which
 * is one of the 14 above, and the intersection turns away values each server stores, which is the
 * failure this file's sibling entries in `COLUMN_FORMATS` were built to avoid. The dialect split
 * is the same one the analyzer already carries for `varchar` characters against TEXT bytes.
 *
 * SingleStore takes MySQL's, which is where every other MySQL-shaped answer in the analyzer goes
 * (see `decimalModeRange`), and mssql takes neither: `MsSqlBigInt` states `string int64` too, and
 * there is no SQL Server here to read a row back from, so it keeps the bare string it had.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, type Column } from '@drzl/analyzer';

const DIR = path.join(__dirname, '.tmp-bigint-string-format');

const SCHEMAS = {
  pg: `
    import { pgTable, bigint } from 'drizzle-orm-v1/pg-core';
    export const t = pgTable('t', {
      b: bigint('b', { mode: 'string' }).notNull(),
      b_num: bigint('b_num', { mode: 'number' }).notNull(),
      b_big: bigint('b_big', { mode: 'bigint' }).notNull(),
    });
  `,
  mysql: `
    import { mysqlTable, bigint } from 'drizzle-orm-v1/mysql-core';
    export const t = mysqlTable('t', {
      b: bigint('b', { mode: 'string' }).notNull(),
      u: bigint('u', { mode: 'string', unsigned: true }).notNull(),
    });
  `,
  singlestore: `
    import { singlestoreTable, bigint } from 'drizzle-orm-v1/singlestore-core';
    export const t = singlestoreTable('t', {
      b: bigint('b', { mode: 'string' }).notNull(),
      u: bigint('u', { mode: 'string', unsigned: true }).notNull(),
    });
  `,
  mssql: `
    import { mssqlTable, bigint } from 'drizzle-orm-v1/mssql-core';
    export const t = mssqlTable('t', {
      b: bigint('b', { mode: 'string' }).notNull(),
    });
  `,
};

const columns: Record<string, Map<string, Column>> = {};

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
  for (const [dialect, source] of Object.entries(SCHEMAS)) {
    const file = path.join(DIR, `${dialect}.mjs`);
    await fs.writeFile(file, source, 'utf8');
    const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
    expect(
      analysis.tables[0],
      `${dialect}: no table analyzed: ${JSON.stringify(analysis.issues)}`
    ).toBeTruthy();
    columns[dialect] = new Map(analysis.tables[0].columns.map((c) => [c.name, c]));
  }
}, 120_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

describe('the format the string mode carries', () => {
  it('states the Postgres input syntax on a Postgres column', () => {
    expect(columns.pg.get('b')).toMatchObject({
      tsType: 'string',
      dbType: 'BIGINT',
      format: 'pgBigint',
    });
  });

  it('states the MySQL one on MySQL, in both the signed and the unsigned spelling', () => {
    expect(columns.mysql.get('b')).toMatchObject({ tsType: 'string', format: 'mysqlBigint' });
    expect(columns.mysql.get('u')).toMatchObject({ tsType: 'string', format: 'mysqlBigint' });
  });

  it("gives SingleStore MySQL's answer, which is where its every other answer comes from", () => {
    expect(columns.singlestore.get('b')).toMatchObject({ tsType: 'string', format: 'mysqlBigint' });
    expect(columns.singlestore.get('u')).toMatchObject({ tsType: 'string', format: 'mysqlBigint' });
  });

  it('leaves mssql bare, because no SQL Server was measured for it', () => {
    expect(columns.mssql.get('b')).toMatchObject({ tsType: 'string', dbType: 'BIGINT' });
    expect(columns.mssql.get('b')?.format).toBeUndefined();
  });

  it('leaves the sibling modes untouched: a format is a fact about a string', () => {
    expect(columns.pg.get('b_num')).toMatchObject({ tsType: 'number', dbType: 'BIGINT' });
    expect(columns.pg.get('b_num')?.format).toBeUndefined();
    expect(columns.pg.get('b_big')).toMatchObject({ tsType: 'bigint', dbType: 'BIGINT' });
    expect(columns.pg.get('b_big')?.format).toBeUndefined();
  });

  it('states no numeric facts, which would make it read as an integer column', () => {
    for (const c of [columns.pg.get('b'), columns.mysql.get('b'), columns.mysql.get('u')]) {
      expect(c?.min, 'min and max together are how isIntegerColumn reads a number column').toBe(
        undefined
      );
      expect(c?.max).toBe(undefined);
      expect(c?.integer).toBe(undefined);
    }
  });
});
