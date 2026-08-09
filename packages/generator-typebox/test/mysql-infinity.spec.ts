/**
 * `Infinity` and `-Infinity` on a MySQL `float`, `double` and `real`, in TypeBox output.
 *
 * A pin rather than a repair, for the reason the zod sibling records: `Type.Number()` refuses a
 * non-finite number with no options at all, measured and asserted below, so this generator already
 * refused both infinities everywhere. What the fix changed is the analysis underneath, where a
 * MySQL float, double and real now state `allowsInfinity: false` instead of stating nothing, and a
 * flag turning from absent to present is exactly what would otherwise add a union branch and the
 * registered kind that goes with it.
 *
 * Both `Value.Check` and `TypeCompiler` are run, because they are two different implementations of
 * the same question and only one of them is what a consumer's hot path uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { TypeBoxGenerator } from '../src/index';

const DIR = path.join(__dirname, '.tmp-mysql-infinity');

const MYSQL = `
  import { mysqlTable, float, double, real } from 'drizzle-orm-v1/mysql-core';
  export const t = mysqlTable('t', {
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
  import { pgTable, doublePrecision } from 'drizzle-orm-v1/pg-core';
  export const t = pgTable('t', { c_double: doublePrecision().notNull() });
`;

type Emitted = { dense: string; module: Record<string, any> };
const built: Record<string, Emitted> = {};

async function build(label: string, source: string): Promise<Emitted> {
  const dir = path.join(DIR, label);
  await fs.mkdir(dir, { recursive: true });
  const schema = path.join(dir, 'schema.mjs');
  await fs.writeFile(schema, source, 'utf8');
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), schema)).analyze({});
  expect(analysis.tables[0], `${label}: no table analyzed`).toBeTruthy();
  await new TypeBoxGenerator(analysis).generate({ outDir: dir } as never);
  const emitted = path.join(dir, `t-${process.pid}.ts`);
  await fs.rename(path.join(dir, 't.typebox.ts'), emitted);
  const text = await fs.readFile(emitted, 'utf8');
  return { dense: text.replace(/\s+/g, ''), module: await import(emitted) };
}

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  for (const [label, source] of [
    ['mysql', MYSQL],
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
const field = (schema: any, key: string, x: unknown) => Value.Check(schema.properties[key], x);
const compiled = (schema: any, key: string, x: unknown) =>
  TypeCompiler.Compile(schema.properties[key]).Check(x);
const rowOf =
  (base: Record<string, unknown>) =>
  (schema: any, key: string, x: unknown): boolean =>
    Value.Check(schema, { ...base, [key]: x });

const INF = [
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
] as const;

describe('what TypeBox does on its own', () => {
  it('refuses a non-finite number with no options at all, in every wrapper', () => {
    for (const [label, value] of INF) {
      expect(Value.Check(Type.Number(), value), `bare, ${label}`).toBe(false);
      expect(
        Value.Check(Type.Union([Type.Number(), Type.Null()]), value),
        `nullable, ${label}`
      ).toBe(false);
      expect(Value.Check(Type.Optional(Type.Number()), value), `optional, ${label}`).toBe(false);
    }
    expect(Value.Check(Type.Number(), 1e300), 'an ordinary large number').toBe(true);
  });
});

describe('a mysql float, double and real column', () => {
  const COLS = ['c_float', 'c_double', 'c_real', 'n_double'];
  const row = rowOf({ c_float: 1.5, c_double: 1.5, c_real: 1.5, n_double: 1.5 });

  it('refuses both infinities in every mode, on the field, compiled and on the row', () => {
    const leaks: string[] = [];
    for (const mode of MODES) {
      const s = built.mysql.module[`${mode}tSchema`];
      expect(row(s, 'c_double', 1.5), `${mode} the baseline row is accepted`).toBe(true);
      for (const name of COLS) {
        for (const [label, value] of INF) {
          if (field(s, name, value)) leaks.push(`${mode} ${name} ${label} field`);
          if (compiled(s, name, value)) leaks.push(`${mode} ${name} ${label} compiled`);
          if (row(s, name, value)) leaks.push(`${mode} ${name} ${label} row`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('states nothing new in the emitted file, and keeps every finite value', () => {
    expect(built.mysql.dense, 'no registered kind for a verdict already reached').not.toContain(
      'DrzlRowCheck'
    );
    expect(built.mysql.dense).not.toContain('Number.isFinite');
    expect(built.mysql.dense).toContain('c_double:Type.Number()');
    for (const mode of MODES) {
      const s = built.mysql.module[`${mode}tSchema`];
      for (const name of ['c_double', 'c_real', 'n_double']) {
        expect(field(s, name, 1e300), `${mode} ${name} 1e300`).toBe(true);
        expect(field(s, name, 1.5), `${mode} ${name} 1.5`).toBe(true);
        expect(field(s, name, NaN), `${mode} ${name} NaN`).toBe(false);
      }
      expect(field(s, 'c_float', 1e300), `${mode} c_float 1e300`).toBe(false);
    }
  });
});

describe('the two controls', () => {
  it('leaves sqlite exactly as it was, refusing both for TypeBox reasons of its own', () => {
    expect(built.sqlite.dense).not.toContain('DrzlRowCheck');
    for (const mode of MODES) {
      const s = built.sqlite.module[`${mode}tSchema`];
      for (const [label, value] of INF) {
        expect(field(s, 'c_real', value), `${mode} ${label}`).toBe(false);
      }
    }
  });

  it('keeps accepting all three on a postgres double, which stores them', () => {
    for (const mode of MODES) {
      const s = built.postgres.module[`${mode}tSchema`];
      for (const [label, value] of INF) {
        expect(field(s, 'c_double', value), `${mode} ${label}`).toBe(true);
        expect(compiled(s, 'c_double', value), `${mode} ${label} compiled`).toBe(true);
      }
      expect(field(s, 'c_double', NaN), `${mode} NaN`).toBe(true);
    }
  });
});
