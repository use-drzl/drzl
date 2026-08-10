/**
 * The floor under a temporal column carried as text: it is not blank.
 *
 * The defect: `date({ mode: 'string' })` and its neighbours were typed `string` and stated nothing
 * else, so every generator emitted a bare string and the schema accepted `''`. Postgres refuses
 * `''` for a date, so the schema admitted a write the database will not take, and `''` is exactly
 * what an untouched form control submits.
 *
 * Nothing stronger is claimed, for the reason `Column.format` already records: Postgres reads
 * `'today'`, `'January 8, 1999'`, `'01/08/1999'` and `'20200101'` as dates, so a date-shaped
 * pattern would turn away rows the server stores. What is left is the floor, and the floor is
 * exact: measured through PGlite, every Postgres temporal type refuses `''` and `' '` and accepts
 * a valid value with surrounding whitespace, so `\S` refuses the same set the server refuses.
 *
 * The engines do not agree, so the grid is pinned per engine and per type rather than assumed:
 *
 *   Postgres 17 (PGlite)  date, time, timetz, timestamp, timestamptz, interval all refuse '' and ' '
 *   MySQL 8.4.11, STRICT  date, datetime, timestamp refuse both; `time` ACCEPTS both and stores
 *                         00:00:00 silently, with SHOW WARNINGS empty
 *
 * So a MySQL `time` carries no format. Refusing there would be stricter than the server, whatever
 * one makes of what it stored.
 *
 * Both drizzle majors, because the two read a column through different machinery (a codec on v1, a
 * class name on 0.4x) and a column the two describe differently is what the cross-major diff
 * exists to catch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, type Column } from '@drzl/analyzer';

const DIR = path.join(__dirname, '.tmp-temporal-text-format');

const source = (pkg: string) => ({
  pg: `
    import { pgTable, date, time, timestamp, interval, text } from '${pkg}/pg-core';
    export const t = pgTable('t', {
      d_str: date('d_str', { mode: 'string' }).notNull(),
      d_date: date('d_date', { mode: 'date' }).notNull(),
      ts_str: timestamp('ts_str', { mode: 'string' }).notNull(),
      tm: time('tm').notNull(),
      iv: interval('iv').notNull(),
      plain: text('plain').notNull(),
    });
  `,
  mysql: `
    import { mysqlTable, date, datetime, time, timestamp, varchar } from '${pkg}/mysql-core';
    export const t = mysqlTable('t', {
      d_str: date('d_str', { mode: 'string' }).notNull(),
      dt_str: datetime('dt_str', { mode: 'string' }).notNull(),
      ts_str: timestamp('ts_str', { mode: 'string' }).notNull(),
      tm: time('tm').notNull(),
      plain: varchar('plain', { length: 10 }).notNull(),
    });
  `,
  sqlite: `
    import { sqliteTable, text, integer } from '${pkg}/sqlite-core';
    export const t = sqliteTable('t', {
      d_txt: text('d_txt').notNull(),
      d_stamp: integer('d_stamp', { mode: 'timestamp' }).notNull(),
    });
  `,
});

const columns: Record<string, Record<string, Map<string, Column>>> = { v1: {}, legacy: {} };

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
  for (const [major, pkg] of [
    ['v1', 'drizzle-orm-v1'],
    ['legacy', 'drizzle-orm'],
  ] as const) {
    for (const [dialect, src] of Object.entries(source(pkg))) {
      const file = path.join(DIR, `${major}-${dialect}.mjs`);
      await fs.writeFile(file, src, 'utf8');
      const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze({});
      expect(
        analysis.tables[0],
        `${major}/${dialect}: no table analyzed: ${JSON.stringify(analysis.issues)}`
      ).toBeTruthy();
      columns[major][dialect] = new Map(analysis.tables[0].columns.map((c) => [c.name, c]));
    }
  }
}, 180_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

describe.each(['v1', 'legacy'] as const)('on drizzle %s', (major) => {
  it('marks every Postgres temporal column carried as text', () => {
    for (const name of ['d_str', 'ts_str', 'tm', 'iv']) {
      expect(columns[major].pg.get(name), name).toMatchObject({
        tsType: 'string',
        format: 'temporalText',
      });
    }
  });

  it('leaves the date mode of the same column alone, since it is not a string at all', () => {
    const c = columns[major].pg.get('d_date');
    expect(c).toMatchObject({ tsType: 'Date' });
    expect(c?.format).toBeUndefined();
  });

  it('leaves an ordinary text column alone', () => {
    expect(columns[major].pg.get('plain')?.format).toBeUndefined();
    expect(columns[major].mysql.get('plain')?.format).toBeUndefined();
  });

  it('marks the MySQL stamps, which refuse a blank', () => {
    for (const name of ['d_str', 'dt_str', 'ts_str']) {
      expect(columns[major].mysql.get(name), name).toMatchObject({
        tsType: 'string',
        format: 'temporalText',
      });
    }
  });

  it('leaves a MySQL time unmarked, because that server takes a blank and stores 00:00:00', () => {
    const c = columns[major].mysql.get('tm');
    expect(c).toMatchObject({ tsType: 'string' });
    expect(c?.format).toBeUndefined();
  });

  it('claims nothing on SQLite, which stores whatever text it is given', () => {
    expect(columns[major].sqlite.get('d_txt')?.format).toBeUndefined();
  });

  it('gives the same answer as the other major, column for column', () => {
    const other = major === 'v1' ? 'legacy' : 'v1';
    for (const dialect of ['pg', 'mysql', 'sqlite'] as const) {
      for (const [name, c] of columns[major][dialect]) {
        expect(columns[other][dialect].get(name)?.format, `${dialect}.${name}`).toBe(c.format);
      }
    }
  });
});
