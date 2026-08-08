/**
 * Unsigned MySQL integers: a real drizzle v1 table through the real analyzer, the resulting
 * documents compiled by ajv in strict mode and run against values.
 *
 * The defect this pins, measured before the fix: the analyzer answered `int unsigned` with the
 * implicit decimal(10,0), `integer: false` and +/-9999999999, so the select document said
 * `number` with those bounds and took -1, 1.5 and 4294967296 on a column that stores none of
 * them.
 *
 * The bigint half is this format's own: a bigint column is a string in a JSON document, held to
 * an integer by its pattern, and the pattern used to spell an optional minus sign whatever the
 * column said. On an unsigned column the sign is the one thing the pattern can state exactly, so
 * `^-?\d+$` narrows to `^\d+$` and '-1' stops validating. Magnitude stays unstated either way:
 * neither 2^63-1 nor 2^64-1 survives a JSON number, which is why these columns are strings in
 * the first place.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { SchemaAnalyzer, type Table } from '@drzl/analyzer';
import { tableSchemas } from '../src/index';

const DIR = path.join(__dirname, '.tmp-unsigned-int-ranges');

const SCHEMA = `
  import { mysqlTable, int, bigint, serial } from 'drizzle-orm-v1/mysql-core';
  export const t = mysqlTable('t', {
    i_u: int('i_u', { unsigned: true }).notNull(),
    b64_u: bigint('b64_u', { mode: 'bigint', unsigned: true }).notNull(),
    ser: serial('ser').notNull(),
  });
`;

let table: Table;

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
  const schema = path.join(DIR, 'schema.mjs');
  await fs.writeFile(schema, SCHEMA, 'utf8');
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), schema)).analyze({});
  expect(analysis.tables[0], `no table analyzed: ${JSON.stringify(analysis.issues)}`).toBeTruthy();
  table = analysis.tables[0];
  await fs.rm(DIR, { recursive: true, force: true });
}, 120_000);

function compile(schema: unknown) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv as never);
  return ajv.compile(schema as never);
}

/** A row of stored maxima, spelled as JSON: the bigint arrives as a decimal string. */
const TOP = { i_u: 4294967295, b64_u: '18446744073709551615', ser: 1 };

describe('the select document, against what the column really stores', () => {
  it('takes the row of stored maxima whole, under ajv strict mode', () => {
    const ok = compile(tableSchemas(table).select);
    expect(ok(TOP), JSON.stringify(ok.errors)).toBe(true);
    expect(ok({ ...TOP, i_u: 0, b64_u: '0' })).toBe(true);
  });

  it('refuses what int unsigned cannot hold', () => {
    const ok = compile(tableSchemas(table).select);
    expect(ok({ ...TOP, i_u: -1 }), 'below the unsigned floor').toBe(false);
    expect(ok({ ...TOP, i_u: 4294967296 }), 'above the unsigned ceiling').toBe(false);
    expect(ok({ ...TOP, i_u: 1.5 }), 'an integer column').toBe(false);
  });

  it('drops the minus sign from the bigint pattern on an unsigned column', () => {
    const ok = compile(tableSchemas(table).select);
    expect(ok({ ...TOP, b64_u: '-1' })).toBe(false);
    expect(ok({ ...TOP, b64_u: 'x' })).toBe(false);
  });

  it('starts the serial at zero', () => {
    const ok = compile(tableSchemas(table).select);
    expect(ok({ ...TOP, ser: -1 })).toBe(false);
  });
});

describe('the insert document, which is the write half of the same fact', () => {
  it('refuses -1 and takes the stored maximum', () => {
    const ok = compile(tableSchemas(table).insert);
    expect(ok({ i_u: -1, b64_u: '1' })).toBe(false);
    expect(ok({ i_u: 4294967295, b64_u: '1' })).toBe(true);
  });
});
