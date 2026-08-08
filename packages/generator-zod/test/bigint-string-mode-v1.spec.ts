/**
 * `bigint({ mode: 'string' })` on Drizzle v1: a real `pgTable` from 1.0.0-rc.4 through the real
 * analyzer and the real zod generator, with the emitted module imported and run.
 *
 * What v1 states, read off real 1.0.0-rc.4 columns rather than assumed:
 *
 *   builder                       dataType       codec
 *   bigint({ mode: 'number' })    number int53   bigint:number
 *   bigint({ mode: 'bigint' })    bigint int64   bigint
 *   bigint({ mode: 'string' })    string int64   bigint:string
 *
 * GROUND TRUTH, PGlite through `drizzle-orm/pglite` 1.0.0-rc.4 on a `bigint` column per mode:
 * mode number selects back `123` as a number, mode bigint `123n` as a bigint, and mode string
 * `'123'` and `'9223372036854775807'` as strings. The mechanism is the codec table: the
 * `bigint:string` codec casts the column to text on the wire and registers no normalize, so the
 * text passes through untouched, where `bigint` normalizes with `BigInt` and `bigint:number` with
 * `Number`. `drizzle-orm/zod` at the same rc agrees: its select schema for mode string accepts
 * '123' and refuses both 123 and 123n.
 *
 * The analyzer's int64 arm keyed tsType only on `js === 'bigint'`, so this column came back
 * `number` and the emitted select schema rejected every row the database returns, in every
 * generator, because they all key on tsType. This spec is the zod half of the repair; the two
 * sibling modes are asserted beside it so the fix cannot overreach.
 *
 * v1-only: drizzle-orm 0.45.2 spells `PgBigIntConfig<'number' | 'bigint'>` and branches only on
 * `mode === "number"`, so 0.4x has no string mode at all and a type-invalid `mode: 'string'`
 * silently builds the `PgBigInt64` bigint mode, which really does return a bigint.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, type Column } from '@drzl/analyzer';
import { ZodGenerator } from '../src/index';

const DIR = path.join(__dirname, '.tmp-bigint-string-v1');

const SCHEMA = `
  import { pgTable, bigint, integer } from 'drizzle-orm-v1/pg-core';
  export const t = pgTable('t', {
    id: integer('id').primaryKey(),
    b_str: bigint('b_str', { mode: 'string' }).notNull(),
    b_num: bigint('b_num', { mode: 'number' }).notNull(),
    b_big: bigint('b_big', { mode: 'bigint' }).notNull(),
  });
`;

let mod: Record<string, any>;
let columns: Map<string, Column>;

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
  const schema = path.join(DIR, 'schema.mjs');
  await fs.writeFile(schema, SCHEMA, 'utf8');
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), schema)).analyze({});
  const table = analysis.tables[0];
  expect(table, `no table analyzed: ${JSON.stringify(analysis.issues)}`).toBeTruthy();
  columns = new Map(table.columns.map((c) => [c.name, c]));
  await new ZodGenerator(analysis).generate({ outDir: DIR } as never);
  const emitted = path.join(DIR, `t-${process.pid}.ts`);
  await fs.rename(path.join(DIR, 't.zod.ts'), emitted);
  mod = await import(emitted);
}, 120_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

const accepts = (schema: any, v: unknown) => schema.safeParse(v).success;

describe('the analyzer, over a real v1 table', () => {
  it('types the string mode as the string the driver returns', () => {
    expect(columns.get('b_str')).toMatchObject({ tsType: 'string', dbType: 'BIGINT' });
  });

  it('leaves the sibling modes exactly where they were', () => {
    expect(columns.get('b_num')).toMatchObject({ tsType: 'number', dbType: 'BIGINT' });
    expect(columns.get('b_big')).toMatchObject({ tsType: 'bigint', dbType: 'BIGINT' });
  });
});

describe('the emitted module, against what the v1 driver returned', () => {
  it('takes the strings the driver hands back, at both ordinary and int64-edge magnitude', () => {
    const s = mod.SelecttSchema.shape.b_str;
    expect(accepts(s, '123'), 'the row the column handed back').toBe(true);
    expect(accepts(s, '9223372036854775807'), 'the int64 maximum, as the driver spells it').toBe(
      true
    );
  });

  it('refuses the two wire types this column never returns', () => {
    const s = mod.SelecttSchema.shape.b_str;
    expect(accepts(s, 123n), 'a bigint never arrives on this wire').toBe(false);
    expect(accepts(s, 123), 'a number never arrives on this wire').toBe(false);
    expect(accepts(s, null), 'null on a NOT NULL column').toBe(false);
  });

  it('still holds the sibling modes to their own wire types', () => {
    const num = mod.SelecttSchema.shape.b_num;
    expect(accepts(num, 123)).toBe(true);
    expect(accepts(num, '123')).toBe(false);
    const big = mod.SelecttSchema.shape.b_big;
    expect(accepts(big, 123n)).toBe(true);
    expect(accepts(big, '123')).toBe(false);
  });

  it('accepts the string on insert too, which is what mapToDriverValue passes through', () => {
    const s = mod.InserttSchema.shape.b_str;
    expect(accepts(s, '123')).toBe(true);
    expect(accepts(s, 123)).toBe(false);
  });
});
