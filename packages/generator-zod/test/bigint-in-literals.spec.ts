/**
 * `CHECK (big IN (1, 2))` on a `bigint({ mode: 'bigint' })` column, run against the wire type the
 * driver actually returns.
 *
 * The driver hands a select back as `bigint` in that mode. Measured ground truth lives in
 * `packages/analyzer/test/decimal-modes.spec.ts`, whose header pins `db.select()` returning
 * `9007199254740993n` for the bigint mode on all three engines (PGlite, mysql2, better-sqlite3),
 * and in the `PgBigInt53`/`PgBigInt64` arms of `packages/analyzer/src/index.ts`, which type the
 * number mode `number` and the bigint mode `bigint` for the same reason.
 *
 * `z.literal(1)` refuses `1n`: strict equality between a bigint and a number is false in
 * JavaScript, so a set emitted as number literals turns away every row the driver returns, which
 * is the read-path failure class. The set has to be spelled in the column's wire type: `1n` on a
 * bigint wire, `1` on a number wire. The OR fold routes `big = 1 OR big = 2` into the same
 * `ColumnSet`, so both spellings of the same constraint are asserted here, and so is the single
 * equality `big = 1`, which is one branch of that OR standing alone.
 *
 * A non-integer member is the one value the bigint spelling cannot carry: `1.5n` is a JavaScript
 * syntax error, and an emitted module that does not parse throws at import. The database says no
 * stored bigint ever equals 1.5, so that member keeps its number spelling, which no bigint
 * satisfies either, and the module keeps loading.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

/** `bigint({ mode: 'number' })`: the driver returns a JS number there, so number literals fit. */
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
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  const text = await fs.readFile(path.join(dir, 't.zod.ts'), 'utf8');
  // Unique per call: the module cache is process-global.
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return { modules: await import(file), text };
}

describe('CHECK (big IN (1, 2)) on bigint mode bigint', () => {
  const IN = [{ name: 'big_valid', expression: 'big IN (1, 2)' }];

  it('accepts the bigints the driver returns and rejects the rest, in every mode', async () => {
    const { modules: m } = await emit([bigB()], IN);
    for (const s of ['SelecttSchema', 'InserttSchema', 'UpdatetSchema']) {
      expect(m[s].safeParse({ big: 1n }).success, `${s} 1n`).toBe(true);
      expect(m[s].safeParse({ big: 2n }).success, `${s} 2n`).toBe(true);
      expect(m[s].safeParse({ big: 3n }).success, `${s} 3n`).toBe(false);
      // The wire carries bigints, so the number 1 is not a value this column ever holds.
      expect(m[s].safeParse({ big: 1 }).success, `${s} number 1`).toBe(false);
    }
  });

  it('still accepts NULL, which the database does', async () => {
    const { modules: m } = await emit([bigB()], IN);
    expect(m.SelecttSchema.safeParse({ big: null }).success).toBe(true);
  });

  it('keeps a 64 bit member exact instead of rounding it', async () => {
    const { modules: m } = await emit(
      [bigB()],
      [{ expression: 'big IN (9223372036854775807)' }]
    );
    expect(m.SelecttSchema.safeParse({ big: 9223372036854775807n }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ big: 9223372036854775806n }).success).toBe(false);
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
    expect(m.SelecttSchema.safeParse({ big: 1n }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ big: 2n }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ big: 3n }).success).toBe(false);
  });
});

describe('a single equality and inequality on the bigint wire', () => {
  it('CHECK (big = 1) accepts 1n and rejects 2n', async () => {
    const { modules: m } = await emit([bigB()], [{ expression: 'big = 1' }]);
    expect(m.SelecttSchema.safeParse({ big: 1n }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ big: 2n }).success).toBe(false);
  });

  it('CHECK (big <> 1) rejects 1n and accepts 2n', async () => {
    const { modules: m } = await emit([bigB()], [{ expression: 'big <> 1' }]);
    expect(m.SelecttSchema.safeParse({ big: 1n }).success).toBe(false);
    expect(m.SelecttSchema.safeParse({ big: 2n }).success).toBe(true);
  });
});

describe('bigint mode number keeps its number literals', () => {
  const IN = [{ expression: 'big IN (1, 2)' }];

  it('accepts the numbers the driver returns there and refuses a bigint', async () => {
    const { modules: m } = await emit([bigN()], IN);
    expect(m.SelecttSchema.safeParse({ big: 1 }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ big: 3 }).success).toBe(false);
    // That wire carries numbers: `1n` is not a value `bigint({ mode: 'number' })` returns.
    expect(m.SelecttSchema.safeParse({ big: 1n }).success).toBe(false);
  });
});

describe('a non-integer member of the set', () => {
  it('cannot become a bigint literal, and the module still loads and enforces the rest', async () => {
    // `big IN (1.5, 2)`: the database coerces on write and no stored bigint ever equals 1.5, so
    // the member that has no bigint spelling keeps its number one, which no bigint satisfies.
    const { modules: m } = await emit([bigB()], [{ expression: 'big IN (1.5, 2)' }]);
    expect(m.SelecttSchema.safeParse({ big: 2n }).success).toBe(true);
    expect(m.SelecttSchema.safeParse({ big: 1n }).success).toBe(false);
    expect(m.SelecttSchema.safeParse({ big: 3n }).success).toBe(false);
  });
});
