/**
 * A `decimal`/`numeric` column's emitted schema, run against the values a real engine returns.
 *
 * The analyzer half of this lives in `packages/analyzer/test/decimal-modes.spec.ts`, which pins the
 * `tsType` of every mode. This half closes the loop the other side cannot: it takes a real drizzle
 * schema through the real analyzer and the real zod generator, imports the module that comes out,
 * and asks it about the exact values measured off a running database. Nothing here is asserted
 * about the text of the generated file.
 *
 * It lives in `@drzl/cli` because this is the only package that has drizzle-orm, `@drzl/analyzer`
 * and a validator library in the same tree, so a fixture written here resolves `drizzle-orm` and
 * the emitted module resolves `zod`.
 *
 * The values, measured before anything was changed. MySQL 8.4.11 in Docker through mysql2,
 * drizzle-orm 0.45.2, reading back a `decimal(10,2)` holding '1234.56' and a `decimal(20,0)`
 * holding '9007199254740993':
 *
 *   mode           class                 db.select() hands back
 *   (default)      MySqlDecimal          '1234.56'          string
 *   mode:'number'  MySqlDecimalNumber    1234.56            number
 *   mode:'bigint'  MySqlDecimalBigInt    9007199254740993n  bigint
 *
 * Postgres through PGlite and SQLite through better-sqlite3 give the same three answers for
 * `numeric`, and official drizzle-zod 0.8.3 on the same columns accepts exactly those three types
 * and refuses the other two, which is the second opinion on which value belongs to which mode.
 *
 * Before the fix the class-name path called all three `number`, so the two string-returning modes
 * and the bigint mode each emitted a schema that rejected every row the database hands back.
 *
 * Requires a build, as `commands.e2e.spec.ts` does: the generator and the analyzer are consumed
 * through their package entry points rather than from source.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ZodGenerator } from '@drzl/generator-zod';

const ROOT = path.join(__dirname, '.decimal-tmp');

const SOURCES: Record<string, string> = {
  mysql: `
    import { mysqlTable, decimal } from 'drizzle-orm/mysql-core';
    export const t = mysqlTable('t', {
      d_def: decimal('d_def', { precision: 10, scale: 2 }).notNull(),
      d_num: decimal('d_num', { precision: 10, scale: 2, mode: 'number' }).notNull(),
      d_big: decimal('d_big', { precision: 20, scale: 0, mode: 'bigint' }).notNull(),
    });
  `,
  singlestore: `
    import { singlestoreTable, decimal } from 'drizzle-orm/singlestore-core';
    export const t = singlestoreTable('t', {
      d_def: decimal('d_def', { precision: 10, scale: 2 }).notNull(),
      d_num: decimal('d_num', { precision: 10, scale: 2, mode: 'number' }).notNull(),
      d_big: decimal('d_big', { precision: 20, scale: 0, mode: 'bigint' }).notNull(),
    });
  `,
  pg: `
    import { pgTable, numeric } from 'drizzle-orm/pg-core';
    export const t = pgTable('t', {
      d_def: numeric('d_def', { precision: 10, scale: 2 }).notNull(),
      d_num: numeric('d_num', { precision: 10, scale: 2, mode: 'number' }).notNull(),
      d_big: numeric('d_big', { precision: 20, scale: 0, mode: 'bigint' }).notNull(),
    });
  `,
  sqlite: `
    import { sqliteTable, numeric } from 'drizzle-orm/sqlite-core';
    export const t = sqliteTable('t', {
      d_def: numeric('d_def').notNull(),
      d_num: numeric('d_num', { mode: 'number' }).notNull(),
      d_big: numeric('d_big', { mode: 'bigint' }).notNull(),
    });
  `,
};

/** The row a driver really hands back, one value per mode, and the four it never does. */
const RETURNED: Record<string, unknown> = {
  d_def: '1234.56',
  d_num: 1234.56,
  d_big: 9007199254740993n,
};
const NEVER_RETURNED: Record<string, unknown[]> = {
  d_def: [1234.56, 9007199254740993n, true, null],
  d_num: ['1234.56', 9007199254740993n, true, null],
  d_big: ['1234.56', 1234.56, true, null],
};

/** Analyze, generate, and import what came out. */
const modules: Record<string, Record<string, any>> = {};

beforeAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  for (const [dialect, source] of Object.entries(SOURCES)) {
    const dir = path.join(ROOT, dialect);
    await fs.mkdir(dir, { recursive: true });
    const schema = path.join(dir, 'schema.mjs');
    await fs.writeFile(schema, source, 'utf8');
    const analysis = await new SchemaAnalyzer(schema).analyze({});
    await new ZodGenerator(analysis).generate({ outDir: dir } as never);
    modules[dialect] = await import(path.join(dir, 't.zod.ts'));
  }
}, 120_000);

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe.each(Object.keys(SOURCES))('%s, through the emitted zod module', (dialect) => {
  it.each(Object.keys(RETURNED))('accepts what the driver returns for %s', (col) => {
    const field = modules[dialect].SelecttSchema.shape[col];
    expect(field, `no field emitted for ${col}`).toBeTruthy();
    const r = field.safeParse(RETURNED[col]);
    expect(r.success, `select schema rejected ${String(RETURNED[col])}`).toBe(true);
  });

  it.each(Object.keys(NEVER_RETURNED))('refuses what the driver never returns for %s', (col) => {
    const field = modules[dialect].SelecttSchema.shape[col];
    for (const v of NEVER_RETURNED[col]) {
      expect(field.safeParse(v).success, `select schema accepted ${String(v)}`).toBe(false);
    }
  });

  it.each(Object.keys(RETURNED))('takes the same value back on insert for %s', (col) => {
    // The insert side matters as much as the select side: `mapToDriverValue` is `String` for the
    // number and bigint modes, so what the caller passes in is the JS type the mode names, not
    // the string the wire carries.
    const field = modules[dialect].InserttSchema.shape[col];
    expect(field.safeParse(RETURNED[col]).success).toBe(true);
  });
});
