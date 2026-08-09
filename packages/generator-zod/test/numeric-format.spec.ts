/**
 * The numeric format check, and why it is the only one.
 *
 * A `numeric`/`decimal` column is returned as a string, because a JS number cannot hold arbitrary
 * precision. That left the schema a bare `z.string()`, which accepts `'hello'` for a numeric
 * column; `drizzle-orm/zod` still does, and Postgres rejects it.
 *
 * The pattern was not reasoned about. It was run against a real Postgres through PGlite over a
 * pool built to include the awkward *valid* forms, because the hazard here is over-rejection: a
 * check that turns away something the database accepts breaks working code. Candidates for
 * `date`, `time`, `macaddr` and `inet` were all built and all discarded for exactly that, each
 * caught by a value Postgres takes and the pattern did not.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import { COLUMN_FORMATS } from '@drzl/validation-core';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'NUMERIC',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

let seq = 0;

async function schemasFor(columns: Column[]): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-numfmt');
  await fs.mkdir(dir, { recursive: true });
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  // Unique per call: the module cache is process-global, so reusing a path would hand back the
  // first module and every later assertion would be made against the wrong schema.
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return await import(file);
}

describe('what Postgres accepts, the schema accepts', () => {
  it.each([
    ['1', '1'],
    ['a decimal', '1.5'],
    ['signed', '-1.5'],
    ['leading dot', '.5'],
    ['an exponent', '1e3'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['surrounding whitespace', '  1  '],
    ['underscore separators, Postgres 16', '1_000'],
    ['a hex literal, Postgres 16', '0x1f'],
    ['an octal literal', '0o17'],
    ['a binary literal', '0b1010'],
  ])('accepts %s', async (_label, value) => {
    const m = await schemasFor([col('amount', { format: 'numeric' })]);
    expect(m.SelecttSchema.shape.amount.safeParse(value).success).toBe(true);
  });
});

describe('what Postgres rejects, the schema rejects', () => {
  it.each([
    ['empty', ''],
    ['a word', 'hello'],
    ['a comma decimal', '1,5'],
    ['two dots', '1.2.3'],
    ['a doubled underscore', '1__0'],
    ['a leading underscore', '_1'],
    ['a trailing underscore', '1_'],
    ['a bare prefix', '0x'],
    ['a dangling exponent', '1e'],
    ['a lone sign', '+'],
  ])('rejects %s', async (_label, value) => {
    const m = await schemasFor([col('amount', { format: 'numeric' })]);
    expect(m.SelecttSchema.shape.amount.safeParse(value).success).toBe(false);
  });
});

describe('scope', () => {
  it('leaves an ordinary string column alone', async () => {
    const m = await schemasFor([col('name', { dbType: 'TEXT' })]);
    expect(m.SelecttSchema.shape.name.safeParse('hello').success).toBe(true);
  });

  it('carries only the formats a server was asked about, since the rest could not be verified', async () => {
    // Postgres reads 'today' as a date and pads '2020-01-01' into a macaddr, so patterns for
    // those turned away valid input and were dropped rather than shipped. The two `bigint` keys
    // are the same rule applied twice over: each was measured against its own server, and there
    // is no third key for mssql because no SQL Server was there to measure.
    expect(Object.keys(COLUMN_FORMATS)).toEqual(['numeric', 'pgBigint', 'mysqlBigint']);
  });
});
