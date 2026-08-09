/**
 * `Infinity` and `-Infinity` on a MySQL `float`, `double` and `real`, in ArkType output.
 *
 * The other half of `nan-union-arm.spec.ts`, which refused `NaN` on the same columns. `NaN` needed
 * a union arm to leak; an infinity needs none, because ArkType's bare `number` takes both wherever
 * it stands. Measured on the installed ArkType and asserted below rather than remembered:
 *
 *   `number`                          takes both infinities, refuses NaN
 *   `-F <= number <= F`               refuses both
 *   `number >= 0`                     takes `Infinity`, refuses `-Infinity`
 *   `(number | null)`, `{ "x?": ... }`  take both, on the object and through `.get`
 *
 * So the magnitude bound was doing this by accident and only where the column has one. MySQL's
 * `float` carries the float32 range and already refused them; `double` and `real` carry no finite
 * bound, because every finite JS number fits in an 8 byte float, and took both.
 *
 * The arbiter is the server. Measured on a real MySQL 8.4.11 in `STRICT_TRANS_TABLES`, on the
 * binary prepared path, which is the one that puts the real IEEE double on the wire: `float`,
 * `double` and `real` all answer `ER_WARN_DATA_OUT_OF_RANGE` for `Infinity`, `-Infinity` and `NaN`
 * alike, and `double`/`real` store 1e300 and 3.4028235e38 unchanged.
 *
 * This runs the 0.4x class-name path of the analyzer, since that is the major this package depends
 * on. The valibot, zod and TypeBox siblings run the v1 codec path, and the two have to agree.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type } from 'arktype';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ArkTypeGenerator } from '../src/index';

const DIR = path.join(__dirname, '.tmp-mysql-infinity');

const MYSQL = `
  import { mysqlTable, float, double, real } from 'drizzle-orm/mysql-core';
  export const t = mysqlTable('t', {
    c_float: float('c_float').notNull(),
    c_double: double('c_double').notNull(),
    c_real: real('c_real').notNull(),
    n_float: float('n_float'),
    n_double: double('n_double'),
    n_real: real('n_real'),
  });
`;

const SINGLESTORE = `
  import { singlestoreTable, float, double, real } from 'drizzle-orm/singlestore-core';
  export const t = singlestoreTable('t', {
    c_float: float('c_float').notNull(),
    c_double: double('c_double').notNull(),
    c_real: real('c_real').notNull(),
    n_double: double('n_double'),
  });
`;

const SQLITE = `
  import { sqliteTable, real } from 'drizzle-orm/sqlite-core';
  export const t = sqliteTable('t', {
    c_real: real('c_real').notNull(),
    n_real: real('n_real'),
  });
`;

const POSTGRES = `
  import { pgTable, real, doublePrecision } from 'drizzle-orm/pg-core';
  export const t = pgTable('t', {
    c_real: real('c_real').notNull(),
    c_double: doublePrecision('c_double').notNull(),
    n_double: doublePrecision('n_double'),
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
  await new ArkTypeGenerator(analysis).generate({ outDir: dir } as never);
  const emitted = path.join(dir, `t-${process.pid}.ts`);
  await fs.rename(path.join(dir, 't.arktype.ts'), emitted);
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
const field = (schema: any, key: string, x: unknown) =>
  !(schema.get(key)(x) instanceof type.errors);

/** The same column through the whole object, which is the path the nullable arm leaks on. */
const rowOf =
  (base: Record<string, unknown>) =>
  (schema: any, key: string, x: unknown): boolean =>
    !(schema({ ...base, [key]: x }) instanceof type.errors);

const INF = [
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
] as const;

describe('what ArkType does on its own', () => {
  it('takes both infinities wherever a bare number stands, and refuses them under a range', () => {
    const bare = type('number');
    for (const [label, value] of INF) {
      expect(bare(value) instanceof type.errors, `bare number, ${label}`).toBe(false);
    }
    const ranged = type('-10 <= number <= 10');
    for (const [label, value] of INF) {
      expect(ranged(value) instanceof type.errors, `ranged, ${label}`).toBe(true);
    }
    // A lone bound holds one end only, which is why the repair cannot key on "has a bound".
    expect(type('number >= 0')(Infinity) instanceof type.errors, 'lone lower bound').toBe(false);
    expect(type('number >= 0')(-Infinity) instanceof type.errors, 'lone lower bound').toBe(true);

    // Both arms this generator emits, on the object and through the field, unlike NaN.
    const nullable = type({ x: '(number | null)' });
    const optional = type({ 'x?': 'number' });
    expect(nullable({ x: Infinity }) instanceof type.errors, 'nullable, on the object').toBe(false);
    expect(optional.get('x')(Infinity) instanceof type.errors, 'optional, on the field').toBe(
      false
    );
    expect(optional({ x: Infinity }) instanceof type.errors, 'optional, on the object').toBe(false);

    // The repair, and that it survives both arms.
    const finite = type('number').narrow((v, ctx) => Number.isFinite(v) || ctx.mustBe('finite'));
    expect(type({ 'x?': finite }).get('x')(Infinity) instanceof type.errors).toBe(true);
    expect(type({ x: finite.or('null') })({ x: Infinity }) instanceof type.errors).toBe(true);
    expect(finite(1.5) instanceof type.errors, 'an ordinary number').toBe(false);
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

  it('still refuses NaN, which the same server refuses on the same columns', () => {
    for (const mode of MODES) {
      const s = built.mysql.module[`${mode}tSchema`];
      for (const name of COLS) expect(field(s, name, NaN), `${mode} ${name}`).toBe(false);
    }
  });

  it('still takes every finite value the column really stores', () => {
    for (const mode of MODES) {
      const s = built.mysql.module[`${mode}tSchema`];
      for (const name of COLS) {
        expect(field(s, name, 1.5), `${mode} ${name} 1.5`).toBe(true);
        expect(field(s, name, 0), `${mode} ${name} 0`).toBe(true);
        expect(field(s, name, 'x'), `${mode} ${name} a string`).toBe(false);
      }
      for (const name of ['c_double', 'c_real', 'n_double', 'n_real']) {
        expect(field(s, name, 1e300), `${mode} ${name} 1e300`).toBe(true);
        expect(field(s, name, 3.4028235e38), `${mode} ${name} 3.4028235e38`).toBe(true);
      }
      expect(field(s, 'c_float', 1e300), `${mode} c_float 1e300`).toBe(false);
      expect(field(s, 'n_float', null), `${mode} n_float null`).toBe(true);
      expect(field(s, 'c_float', null), `${mode} c_float null on NOT NULL`).toBe(false);
      expect(row(s, 'n_double', null), `${mode} n_double null, row`).toBe(true);
    }
  });

  it('carries one narrow per column and picks the wider of the two predicates', () => {
    const { dense } = built.mysql;
    const F = '340282346638528859811704183484516925440';
    // The bounded 4 byte column keeps its plain DSL string wherever it is not a union arm: the
    // range already refuses both infinities, so only NaN is left to state and only where NaN leaks.
    expect(dense, 'select keeps the bare range').toContain(`c_float:'-${F}<=number<=${F}'`);
    // `Number.isFinite` is false for NaN too, so a column carrying it needs no second narrow.
    // Four unbounded columns, once in each of the three schemas the file exports.
    expect(dense.match(/Number\.isFinite/g)?.length ?? 0, 'double and real, not float').toBe(12);
    // NaN alone is left where a bound already holds the infinities back: `c_float` is a union arm
    // in update only, and `n_float` in all three modes.
    expect(dense.match(/Number\.isNaN/g)?.length ?? 0, 'float only, and only where it leaks').toBe(
      4
    );
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
    expect(built.sqlite.dense, 'nothing was added').not.toContain('Number.isFinite');
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
    // `!Number.isFinite` already appears here, on the accept side: a Postgres `real` that stores
    // all three keeps its magnitude bound in a narrow, since the DSL cannot hold four branches. So
    // the assertion is on the refusal's own message rather than on the predicate both share.
    expect(built.postgres.dense, 'nothing refuses one here').not.toContain("'afinitenumber'");
  });
});
