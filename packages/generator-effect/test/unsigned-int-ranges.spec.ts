/**
 * Unsigned MySQL integers, end to end: a real drizzle v1 table through the real analyzer and the
 * real Effect generator, with the emitted module imported and whole rows pushed through it.
 *
 * The defect this pins, measured before the fix: the analyzer answered `int unsigned` with the
 * implicit decimal(10,0), `integer: false` and +/-9999999999, so the emitted select schema took
 * -1, 1.5 and 4294967296 on a column that stores none of them, and it answered
 * `bigint({ mode: 'bigint', unsigned: true })` with the signed int64 range, so the select schema
 * refused 18446744073709551615n, which MySQL 8.4.11 stores in a `bigint unsigned` and mysql2
 * really returns.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { EffectGenerator } from '../src/index';
import { accepts } from './fixtures';

const DIR = path.join(__dirname, '.tmp-unsigned-int-ranges');

const SCHEMA = `
  import { mysqlTable, int, bigint, serial } from 'drizzle-orm-v1/mysql-core';
  export const t = mysqlTable('t', {
    i_u: int('i_u', { unsigned: true }).notNull(),
    b64_u: bigint('b64_u', { mode: 'bigint', unsigned: true }).notNull(),
    ser: serial('ser').notNull(),
  });
`;

let mod: Record<string, any>;

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
  const schema = path.join(DIR, 'schema.mjs');
  await fs.writeFile(schema, SCHEMA, 'utf8');
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), schema)).analyze({});
  expect(analysis.tables[0], `no table analyzed: ${JSON.stringify(analysis.issues)}`).toBeTruthy();
  await new EffectGenerator(analysis).generate({ outDir: DIR } as never);
  const emitted = path.join(DIR, `t-${process.pid}.ts`);
  await fs.rename(path.join(DIR, 't.effect.ts'), emitted);
  mod = await import(emitted);
}, 120_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

/** A row the fixed schema must accept whole: every column at its stored maximum. */
const TOP = { i_u: 4294967295, b64_u: 18446744073709551615n, ser: 9007199254740991 };

const selects = (over: Record<string, unknown>) => accepts(mod.SelecttSchema, { ...TOP, ...over });

describe('the select schema, against what the column really stores', () => {
  it('takes the row of stored maxima whole', () => {
    expect(selects({})).toBe(true);
    expect(selects({ i_u: 0, b64_u: 0n, ser: 0 })).toBe(true);
  });

  it('refuses what int unsigned cannot hold', () => {
    expect(selects({ i_u: -1 }), 'below the unsigned floor').toBe(false);
    expect(selects({ i_u: 4294967296 }), 'above the unsigned ceiling').toBe(false);
    expect(selects({ i_u: 1.5 }), 'an integer column').toBe(false);
  });

  it('refuses what bigint unsigned cannot hold, in either direction', () => {
    expect(selects({ b64_u: -1n })).toBe(false);
    expect(selects({ b64_u: 18446744073709551616n })).toBe(false);
    expect(selects({ b64_u: 4 }), 'a number never arrives on this wire').toBe(false);
  });

  it('starts the serial at zero', () => {
    expect(selects({ ser: -1 })).toBe(false);
  });
});

describe('the insert schema, which is the write half of the same fact', () => {
  it('refuses -1 and takes the stored maximum', () => {
    const withSer = (v: Record<string, unknown>) => ({ i_u: 1, b64_u: 1n, ...v });
    expect(accepts(mod.InserttSchema, withSer({ i_u: -1 }))).toBe(false);
    expect(accepts(mod.InserttSchema, withSer({ i_u: 4294967295 }))).toBe(true);
  });
});
