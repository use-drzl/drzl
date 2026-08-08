/**
 * Unsigned MySQL integers, end to end: a real drizzle v1 table through the real analyzer and the
 * real zod generator, with the emitted module imported and run.
 *
 * The read-path defect this pins: `int('x', { unsigned: true })` used to come back from the
 * analyzer as the implicit decimal(10,0), `integer: false` with a +/-9999999999 bound, so the
 * select schema took -1, 1.5 and 4294967296 on a column that stores none of them. And
 * `bigint({ mode: 'bigint', unsigned: true })` fell back to the signed int64 range, so the select
 * schema refused 18446744073709551615n, a value the driver really returns: MySQL 8.4.11 stores
 * 2^64-1 in a `bigint unsigned` and mysql2 hands it back, `1.8446744073709551615e19` only to a
 * schema that rejects it.
 *
 * The CHECK columns prove the wire machinery is unmoved by unsignedness: an unsigned int is still
 * a number wire and an unsigned bigint in bigint mode is still a bigint wire, so a CHECK literal
 * folds into the bound in the wire's own spelling, `10` on the one and `10n` on the other, with
 * the unsigned ceiling standing beside it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ZodGenerator } from '../src/index';

const DIR = path.join(__dirname, '.tmp-unsigned-int-ranges');

const SCHEMA = `
  import { mysqlTable, int, bigint, serial, check } from 'drizzle-orm-v1/mysql-core';
  import { sql } from 'drizzle-orm-v1';
  export const t = mysqlTable('t', {
    i_u: int('i_u', { unsigned: true }).notNull(),
    b64_u: bigint('b64_u', { mode: 'bigint', unsigned: true }).notNull(),
    ser: serial('ser'),
    i_c: int('i_c', { unsigned: true }).notNull(),
    b64_c: bigint('b64_c', { mode: 'bigint', unsigned: true }).notNull(),
  }, (t) => [
    check('i_c_floor', sql\`\${t.i_c} >= 10\`),
    check('b64_c_floor', sql\`\${t.b64_c} >= 10\`),
  ]);
`;

let mod: Record<string, any>;
let text: string;

beforeAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(DIR, { recursive: true });
  const schema = path.join(DIR, 'schema.mjs');
  await fs.writeFile(schema, SCHEMA, 'utf8');
  const analysis = await new SchemaAnalyzer(path.relative(process.cwd(), schema)).analyze({});
  expect(analysis.tables[0], `no table analyzed: ${JSON.stringify(analysis.issues)}`).toBeTruthy();
  await new ZodGenerator(analysis).generate({ outDir: DIR } as never);
  text = await fs.readFile(path.join(DIR, 't.zod.ts'), 'utf8');
  const emitted = path.join(DIR, `t-${process.pid}.ts`);
  await fs.rename(path.join(DIR, 't.zod.ts'), emitted);
  mod = await import(emitted);
}, 120_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

const accepts = (schema: any, v: unknown) => schema.safeParse(v).success;

describe('int unsigned, on the select path', () => {
  it('takes every value the column stores, to the top', () => {
    const s = mod.SelecttSchema.shape.i_u;
    expect(accepts(s, 0)).toBe(true);
    expect(accepts(s, 4294967295), 'the stored maximum of an int unsigned').toBe(true);
  });

  it('refuses what the column cannot hold', () => {
    const s = mod.SelecttSchema.shape.i_u;
    expect(accepts(s, -1), 'below the unsigned floor').toBe(false);
    expect(accepts(s, 4294967296), 'above the unsigned ceiling').toBe(false);
    expect(accepts(s, 1.5), 'an integer column').toBe(false);
  });

  it('refuses -1 on insert too, which is the write half of the same fact', () => {
    const s = mod.InserttSchema.shape.i_u;
    expect(accepts(s, -1)).toBe(false);
    expect(accepts(s, 4294967295)).toBe(true);
  });
});

describe('bigint unsigned in bigint mode, whose ceiling a bigint can spell exactly', () => {
  it('takes the stored maximum back', () => {
    const s = mod.SelecttSchema.shape.b64_u;
    expect(accepts(s, 0n)).toBe(true);
    expect(accepts(s, 18446744073709551615n), 'the stored maximum, 2^64-1').toBe(true);
  });

  it('refuses beyond either edge, and the wrong wire type', () => {
    const s = mod.SelecttSchema.shape.b64_u;
    expect(accepts(s, -1n)).toBe(false);
    expect(accepts(s, 18446744073709551616n)).toBe(false);
    expect(accepts(s, 4), 'a number never arrives on this wire').toBe(false);
  });
});

describe('serial, which is bigint unsigned auto_increment under a shorter name', () => {
  it('starts at zero and stops at the safe-integer ceiling its number mode imposes', () => {
    const s = mod.SelecttSchema.shape.ser;
    expect(accepts(s, 1)).toBe(true);
    expect(accepts(s, 9007199254740991)).toBe(true);
    expect(accepts(s, -1)).toBe(false);
  });
});

describe('a CHECK on an unsigned column still lands on its wire', () => {
  it('folds the number literal into the bound beside the unsigned ceiling', () => {
    expect(text).toContain('.gte(10).lte(4294967295)');
    const s = mod.SelecttSchema.shape.i_c;
    expect(accepts(s, 10)).toBe(true);
    expect(accepts(s, 9), 'the CHECK floor replaced the type floor').toBe(false);
    expect(accepts(s, 4294967296)).toBe(false);
  });

  it('spells the literal 10n on the bigint wire, with the unsigned ceiling beside it', () => {
    expect(text).toContain('.gte(10n).lte(18446744073709551615n)');
    const s = mod.SelecttSchema.shape.b64_c;
    expect(accepts(s, 10n)).toBe(true);
    expect(accepts(s, 9n)).toBe(false);
    expect(accepts(s, 18446744073709551615n)).toBe(true);
  });
});
