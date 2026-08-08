/**
 * `CHECK (big IN (1, 2))` on a `bigint({ mode: 'bigint' })` column, run against the wire type the
 * driver actually returns.
 *
 * The driver hands a select back as `bigint` in that mode: ground truth in
 * `packages/analyzer/test/decimal-modes.spec.ts` (measured through PGlite, mysql2 and
 * better-sqlite3) and the `PgBigInt53`/`PgBigInt64` arms of `packages/analyzer/src/index.ts`.
 *
 * `v.literal(1)` refuses `1n`: strict equality between a bigint and a number is false, so number
 * literals reject every row the driver returns. The set is spelled in the wire type instead, and
 * the measured library facts back it: `v.literal(1n)` on the installed valibot accepts `1n`,
 * rejects `3n` and rejects the number `1`.
 */
import { describe, it, expect } from 'vitest';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ValibotGenerator } from '../src/index';
import * as v from 'valibot';

const SUFFIX = '.valibot.ts';
const RUN = (schema: any, input: unknown) => v.safeParse(schema, input).success;

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: true,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

/** `bigint({ mode: 'bigint' })` as the analyzer records it: tsType bigint, int64 range. */
const bigB = () =>
  col('big', {
    tsType: 'bigint',
    dbType: 'BIGINT',
    integer: true,
    min: '-9223372036854775808',
    max: '9223372036854775807',
  });

/** `bigint({ mode: 'number' })`: the driver returns a JS number there. */
const bigN = () =>
  col('big', {
    tsType: 'number',
    dbType: 'BIGINT',
    integer: true,
    min: '-9007199254740991',
    max: '9007199254740991',
  });

let seq = 0;

async function emit(
  columns: Column[],
  checks: { name?: string; expression?: string }[]
): Promise<{ modules: Record<string, any>; text: string }> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-bigint-in');
  await fs.mkdir(dir, { recursive: true });
  await new ValibotGenerator(analysis).generate({ outDir: dir } as never);
  const text = await fs.readFile(path.join(dir, `t${SUFFIX}`), 'utf8');
  // Unique per call: the module cache is process-global.
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, `t${SUFFIX}`), file);
  return { modules: await import(file), text };
}

describe('CHECK (big IN (1, 2)) on bigint mode bigint', () => {
  const IN = [{ name: 'big_valid', expression: 'big IN (1, 2)' }];

  it('accepts the bigints the driver returns and rejects the rest, in every mode', async () => {
    const { modules: m } = await emit([bigB()], IN);
    for (const s of ['SelecttSchema', 'InserttSchema', 'UpdatetSchema']) {
      expect(RUN(m[s], { big: 1n }), `${s} 1n`).toBe(true);
      expect(RUN(m[s], { big: 2n }), `${s} 2n`).toBe(true);
      expect(RUN(m[s], { big: 3n }), `${s} 3n`).toBe(false);
      // The wire carries bigints, so the number 1 is not a value this column ever holds.
      expect(RUN(m[s], { big: 1 }), `${s} number 1`).toBe(false);
    }
  });

  it('still accepts NULL, which the database does', async () => {
    const { modules: m } = await emit([bigB()], IN);
    expect(RUN(m.SelecttSchema, { big: null })).toBe(true);
  });

  it('keeps a 64 bit member exact instead of rounding it', async () => {
    const { modules: m } = await emit(
      [bigB()],
      [{ expression: 'big IN (9223372036854775807)' }]
    );
    expect(RUN(m.SelecttSchema, { big: 9223372036854775807n })).toBe(true);
    expect(RUN(m.SelecttSchema, { big: 9223372036854775806n })).toBe(false);
  });
});

describe('the OR fold of the same constraint', () => {
  it('emits byte for byte what the IN list it means emits', async () => {
    const a = await emit([bigB()], [{ name: 'big_valid', expression: 'big = 1 OR big = 2' }]);
    const b = await emit([bigB()], [{ name: 'big_valid', expression: 'big IN (1, 2)' }]);
    expect(a.text).toBe(b.text);
  });

  it('accepts 1n and rejects 3n like the IN it folds to', async () => {
    const { modules: m } = await emit([bigB()], [{ expression: 'big = 1 OR big = 2' }]);
    expect(RUN(m.SelecttSchema, { big: 1n })).toBe(true);
    expect(RUN(m.SelecttSchema, { big: 2n })).toBe(true);
    expect(RUN(m.SelecttSchema, { big: 3n })).toBe(false);
  });
});

describe('a single equality and inequality on the bigint wire', () => {
  it('CHECK (big = 1) accepts 1n and rejects 2n', async () => {
    const { modules: m } = await emit([bigB()], [{ expression: 'big = 1' }]);
    expect(RUN(m.SelecttSchema, { big: 1n })).toBe(true);
    expect(RUN(m.SelecttSchema, { big: 2n })).toBe(false);
  });

  it('CHECK (big <> 1) rejects 1n and accepts 2n', async () => {
    const { modules: m } = await emit([bigB()], [{ expression: 'big <> 1' }]);
    expect(RUN(m.SelecttSchema, { big: 1n })).toBe(false);
    expect(RUN(m.SelecttSchema, { big: 2n })).toBe(true);
  });
});

describe('bigint mode number keeps its number literals', () => {
  it('accepts the numbers the driver returns there and refuses a bigint', async () => {
    const { modules: m } = await emit([bigN()], [{ expression: 'big IN (1, 2)' }]);
    expect(RUN(m.SelecttSchema, { big: 1 })).toBe(true);
    expect(RUN(m.SelecttSchema, { big: 3 })).toBe(false);
    expect(RUN(m.SelecttSchema, { big: 1n })).toBe(false);
  });
});

describe('a non-integer member of the set', () => {
  it('cannot become a bigint literal, and the module still loads and enforces the rest', async () => {
    // `1.5n` is a syntax error, so that member keeps its number spelling, which no stored bigint
    // ever equals, exactly as the database says.
    const { modules: m } = await emit([bigB()], [{ expression: 'big IN (1.5, 2)' }]);
    expect(RUN(m.SelecttSchema, { big: 2n })).toBe(true);
    expect(RUN(m.SelecttSchema, { big: 1n })).toBe(false);
    expect(RUN(m.SelecttSchema, { big: 3n })).toBe(false);
  });
});
