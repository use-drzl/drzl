/**
 * Unsigned MySQL integers, end to end: a real drizzle v1 table through the real analyzer and the
 * real valibot generator, with the emitted module imported and run.
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
import * as v from 'valibot';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ValibotGenerator } from '../src/index';

const DIR = path.join(__dirname, '.tmp-unsigned-int-ranges');

const SCHEMA = `
  import { mysqlTable, int, bigint, serial } from 'drizzle-orm-v1/mysql-core';
  export const t = mysqlTable('t', {
    i_u: int('i_u', { unsigned: true }).notNull(),
    b64_u: bigint('b64_u', { mode: 'bigint', unsigned: true }).notNull(),
    ser: serial('ser'),
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
  await new ValibotGenerator(analysis).generate({ outDir: DIR } as never);
  const emitted = path.join(DIR, `t-${process.pid}.ts`);
  await fs.rename(path.join(DIR, 't.valibot.ts'), emitted);
  mod = await import(emitted);
}, 120_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

const ok = (schema: any, value: unknown) => v.safeParse(schema, value).success;

describe('int unsigned, on the select path', () => {
  it('takes every value the column stores, to the top', () => {
    const s = mod.SelecttSchema.entries.i_u;
    expect(ok(s, 0)).toBe(true);
    expect(ok(s, 4294967295), 'the stored maximum of an int unsigned').toBe(true);
  });

  it('refuses what the column cannot hold', () => {
    const s = mod.SelecttSchema.entries.i_u;
    expect(ok(s, -1), 'below the unsigned floor').toBe(false);
    expect(ok(s, 4294967296), 'above the unsigned ceiling').toBe(false);
    expect(ok(s, 1.5), 'an integer column').toBe(false);
  });

  it('refuses -1 on insert too, which is the write half of the same fact', () => {
    const s = mod.InserttSchema.entries.i_u;
    expect(ok(s, -1)).toBe(false);
    expect(ok(s, 4294967295)).toBe(true);
  });
});

describe('bigint unsigned in bigint mode, whose ceiling a bigint can spell exactly', () => {
  it('takes the stored maximum back and refuses beyond either edge', () => {
    const s = mod.SelecttSchema.entries.b64_u;
    expect(ok(s, 0n)).toBe(true);
    expect(ok(s, 18446744073709551615n), 'the stored maximum, 2^64-1').toBe(true);
    expect(ok(s, -1n)).toBe(false);
    expect(ok(s, 18446744073709551616n)).toBe(false);
    expect(ok(s, 4), 'a number never arrives on this wire').toBe(false);
  });
});

describe('serial, which is bigint unsigned auto_increment under a shorter name', () => {
  it('starts at zero and stops at the safe-integer ceiling its number mode imposes', () => {
    const s = mod.SelecttSchema.entries.ser;
    expect(ok(s, 1)).toBe(true);
    expect(ok(s, 9007199254740991)).toBe(true);
    expect(ok(s, -1)).toBe(false);
  });
});
