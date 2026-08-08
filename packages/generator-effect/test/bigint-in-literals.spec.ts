/**
 * `CHECK (big IN (1, 2))` on a `bigint({ mode: 'bigint' })` column, run against the wire type the
 * driver actually returns.
 *
 * The driver hands a select back as `bigint` in that mode: ground truth in
 * `packages/analyzer/test/decimal-modes.spec.ts` (measured through PGlite, mysql2 and
 * better-sqlite3) and the `PgBigInt53`/`PgBigInt64` arms of `packages/analyzer/src/index.ts`.
 *
 * `Schema.Literal(1, 2)` refuses `1n`: effect compares a literal with strict equality, and a
 * bigint never strictly equals a number. Measured on the installed effect,
 * `Schema.Literal(1n, 2n)` decodes `1n`, refuses `3n` and refuses the number `1`, so the set is
 * spelled in the wire type.
 */
import { describe, it, expect } from 'vitest';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EffectGenerator } from '../src/index';
import * as Either from 'effect/Either';
import * as Schema from 'effect/Schema';

const SUFFIX = '.effect.ts';
const RUN = (schema: any, input: unknown) =>
  Either.isRight(Schema.decodeUnknownEither(schema as Schema.Schema<unknown>)(input));

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
  await new EffectGenerator(analysis).generate({ outDir: dir } as never);
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
