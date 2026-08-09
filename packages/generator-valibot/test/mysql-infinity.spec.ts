/**
 * `Infinity` and `-Infinity` on a MySQL `float`, `double` and `real`, in valibot output.
 *
 * The sibling of `non-finite-numbers.spec.ts`, asking the opposite question of a different
 * database. That file asks what a Postgres float must *accept*; this one asks what a MySQL one must
 * refuse, and the arbiter is the server. Measured on a real MySQL 8.4.11 in `STRICT_TRANS_TABLES`,
 * on the binary prepared path, which is the one that puts the real IEEE double on the wire:
 *
 *   float, double, real     Infinity, -Infinity and NaN all refused, ER_WARN_DATA_OUT_OF_RANGE
 *   double, real            1e300 and 3.4028235e38 stored and returned unchanged
 *
 * mysql2's text protocol interpolates a JS number through `toString`, so a placeholder carrying
 * `Infinity` reaches the server as the bare word `Infinity` and comes back "Unknown column
 * 'Infinity' in 'field list'". That is a client artifact and says nothing about the column, which is
 * why the measurement above is the prepared one.
 *
 * The mechanism is valibot's and it is a magnitude bound doing the work by accident: `v.number()`
 * takes both infinities, `v.maxValue(n)` refuses `+Infinity` whatever `n` is and `v.minValue(n)`
 * refuses `-Infinity`. So MySQL's `float`, which carries the float32 range, already refused them,
 * and `double` and `real`, which carry no finite bound because every finite JS number fits, took
 * both. The analyzer states the refusal outright now and the generator emits a finite check where
 * no bound already holds.
 *
 * SQLite is the control that must not move, and it is not the same answer: a real SQLite 3.53.4
 * stores both infinities in a `real` and hands them back, and turns `NaN` into NULL. Postgres is
 * the other control: it stores all three and a schema refusing them refuses rows the column
 * returns.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import * as v from 'valibot';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ValibotGenerator } from '../src/index';

const DIR = path.join(__dirname, '.tmp-mysql-infinity');

const MYSQL = `
  import { mysqlTable, float, double, real } from 'drizzle-orm-v1/mysql-core';
  export const t = mysqlTable('t', {
    c_float: float().notNull(),
    c_double: double().notNull(),
    c_real: real().notNull(),
    n_float: float(),
    n_double: double(),
    n_real: real(),
  });
`;

const SINGLESTORE = `
  import { singlestoreTable, float, double, real } from 'drizzle-orm-v1/singlestore-core';
  export const t = singlestoreTable('t', {
    c_float: float().notNull(),
    c_double: double().notNull(),
    c_real: real().notNull(),
    n_double: double(),
  });
`;

const SQLITE = `
  import { sqliteTable, real } from 'drizzle-orm-v1/sqlite-core';
  export const t = sqliteTable('t', { c_real: real().notNull(), n_real: real() });
`;

const POSTGRES = `
  import { pgTable, real, doublePrecision } from 'drizzle-orm-v1/pg-core';
  export const t = pgTable('t', {
    c_real: real().notNull(),
    c_double: doublePrecision().notNull(),
    n_double: doublePrecision(),
  });
`;

/** `dense` is the source with every space removed, so an assertion cannot depend on line breaks. */
type Emitted = { source: string; dense: string; module: Record<string, any> };
const built: Record<string, Emitted> = {};

async function build(label: string, source: string): Promise<Emitted> {
  const dir = path.join(DIR, label);
  await fs.mkdir(dir, { recursive: true });
  const schema = path.join(dir, 'schema.mjs');
  await fs.writeFile(schema, source, 'utf8');
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), schema)).analyze({});
  expect(analysis.tables[0], `${label}: no table analyzed`).toBeTruthy();
  await new ValibotGenerator(analysis).generate({ outDir: dir } as never);
  const emitted = path.join(dir, `t-${process.pid}.ts`);
  await fs.rename(path.join(dir, 't.valibot.ts'), emitted);
  const text = await fs.readFile(emitted, 'utf8');
  return {
    source: text.replace(/\s+/g, ' '),
    dense: text.replace(/\s+/g, ''),
    module: await import(emitted),
  };
}

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  for (const [label, source] of [
    ['mysql', MYSQL],
    ['singlestore', SINGLESTORE],
    ['sqlite', SQLITE],
    ['postgres', POSTGRES],
  ] as const) {
    built[label] = await build(label, source);
  }
}, 180_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

const MODES = ['Select', 'Insert', 'Update'] as const;

/** One column pulled out of the schema, which is how the packed gate takes a schema apart. */
const field = (schema: any, key: string, x: unknown) => v.safeParse(schema.entries[key], x).success;

/** The same column through the whole object, with every other key filled with a value it takes. */
const rowOf =
  (base: Record<string, unknown>) =>
  (schema: any, key: string, x: unknown): boolean =>
    v.safeParse(schema, { ...base, [key]: x }).success;

const INF = [
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
] as const;

describe('what valibot does on its own', () => {
  it('takes both infinities unbounded, and each bound refuses only its own end', () => {
    expect(v.safeParse(v.number(), Infinity).success, 'bare number, Infinity').toBe(true);
    expect(v.safeParse(v.number(), -Infinity).success, 'bare number, -Infinity').toBe(true);
    const hi = v.pipe(v.number(), v.maxValue(10));
    expect(v.safeParse(hi, Infinity).success, 'maxValue, Infinity').toBe(false);
    expect(v.safeParse(hi, -Infinity).success, 'maxValue, -Infinity').toBe(true);
    const lo = v.pipe(v.number(), v.minValue(-10));
    expect(v.safeParse(lo, Infinity).success, 'minValue, Infinity').toBe(true);
    expect(v.safeParse(lo, -Infinity).success, 'minValue, -Infinity').toBe(false);
    // The repair, and that it survives the two wrappers a column gets.
    const finite = v.pipe(
      v.number(),
      v.check((x) => Number.isFinite(x), 'finite')
    );
    for (const [, value] of INF) expect(v.safeParse(finite, value).success).toBe(false);
    expect(v.safeParse(v.nullable(finite), Infinity).success, 'nullable').toBe(false);
    expect(v.safeParse(v.optional(finite), Infinity).success, 'optional').toBe(false);
    expect(v.safeParse(finite, 1.5).success, 'an ordinary number').toBe(true);
  });
});

describe('a mysql float, double and real column', () => {
  const COLS = ['c_float', 'c_double', 'c_real', 'n_float', 'n_double', 'n_real'];
  const row = rowOf({
    c_float: 1.5,
    c_double: 1.5,
    c_real: 1.5,
    n_float: 1.5,
    n_double: 1.5,
    n_real: 1.5,
  });

  it('refuses both infinities in every mode, on the field and on the row', () => {
    const leaks: string[] = [];
    for (const mode of MODES) {
      const s = built.mysql.module[`${mode}tSchema`];
      expect(row(s, 'c_double', 1.5), `${mode} the baseline row is accepted`).toBe(true);
      for (const name of COLS) {
        for (const [label, value] of INF) {
          if (field(s, name, value)) leaks.push(`${mode} ${name} ${label} field`);
          if (row(s, name, value)) leaks.push(`${mode} ${name} ${label} row`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('still takes every finite value the column really stores', () => {
    for (const mode of MODES) {
      const s = built.mysql.module[`${mode}tSchema`];
      for (const name of COLS) {
        expect(field(s, name, 1.5), `${mode} ${name} 1.5`).toBe(true);
        expect(field(s, name, 0), `${mode} ${name} 0`).toBe(true);
        expect(field(s, name, NaN), `${mode} ${name} NaN`).toBe(false);
        expect(field(s, name, 'x'), `${mode} ${name} a string`).toBe(false);
      }
      // The 8 byte columns hold every finite JS number, and MySQL returned both of these.
      for (const name of ['c_double', 'c_real', 'n_double', 'n_real']) {
        expect(field(s, name, 1e300), `${mode} ${name} 1e300`).toBe(true);
        expect(field(s, name, 3.4028235e38), `${mode} ${name} 3.4028235e38`).toBe(true);
      }
      // The 4 byte one keeps the float32 edge, which MySQL refuses past.
      expect(field(s, 'c_float', 1e300), `${mode} c_float 1e300`).toBe(false);
      expect(field(s, 'n_float', null), `${mode} n_float null`).toBe(true);
      expect(field(s, 'c_float', null), `${mode} c_float null on NOT NULL`).toBe(false);
    }
  });

  it('spends the check only where no bound already refuses an infinity', () => {
    const { dense } = built.mysql;
    const F = '340282346638528859811704183484516925440';
    // `float` carries the float32 range, so `v.minValue`/`v.maxValue` already refuse both ends and
    // a check beside them would be bytes in the consumer's bundle for a verdict already reached.
    expect(dense, 'the bounded 4 byte column keeps its plain pipe').toContain(
      `c_float:v.pipe(v.number(),v.minValue(-${F}),v.maxValue(${F}))`
    );
    expect(dense, 'the unbounded 8 byte one gains the check').toContain(
      "c_double:v.pipe(v.number(),v.check((val)=>Number.isFinite(val),'afinitenumber'))"
    );
    // Four of the six columns, once in each of the three schemas the file exports: every mode
    // renders every column, so a per-column repair appears three times.
    expect(dense.match(/Number\.isFinite/g)?.length ?? 0, 'double and real, not float').toBe(12);
  });
});

describe('a singlestore column, which mirrors mysql', () => {
  it('refuses both infinities on double and real', () => {
    for (const mode of MODES) {
      const s = built.singlestore.module[`${mode}tSchema`];
      for (const name of ['c_double', 'c_real', 'n_double']) {
        for (const [label, value] of INF) {
          expect(field(s, name, value), `${mode} ${name} ${label}`).toBe(false);
        }
        expect(field(s, name, 1e300), `${mode} ${name} 1e300`).toBe(true);
      }
      expect(field(s, 'c_float', Infinity), `${mode} c_float`).toBe(false);
    }
  });
});

describe('sqlite, which is a different answer and must not move', () => {
  it('keeps accepting both infinities, which the engine really stores and returns', () => {
    for (const mode of MODES) {
      const s = built.sqlite.module[`${mode}tSchema`];
      for (const name of ['c_real', 'n_real']) {
        for (const [label, value] of INF) {
          expect(field(s, name, value), `${mode} ${name} ${label}`).toBe(true);
        }
      }
    }
    expect(built.sqlite.source, 'nothing was added').not.toContain('Number.isFinite');
  });
});

describe('postgres, which stores all three and hands them back', () => {
  it('keeps accepting both infinities and NaN', () => {
    for (const mode of MODES) {
      const s = built.postgres.module[`${mode}tSchema`];
      for (const name of ['c_real', 'c_double', 'n_double']) {
        for (const [label, value] of INF) {
          expect(field(s, name, value), `${mode} ${name} ${label}`).toBe(true);
        }
        expect(field(s, name, NaN), `${mode} ${name} NaN`).toBe(true);
      }
      expect(field(s, 'c_real', 1e300), `${mode} c_real 1e300`).toBe(false);
    }
    expect(built.postgres.source, 'nothing was added').not.toContain('Number.isFinite');
  });
});
