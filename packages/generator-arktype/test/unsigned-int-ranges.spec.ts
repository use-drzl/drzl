/**
 * Unsigned MySQL integers on drizzle-orm 0.45.2, the major this package depends on and the one
 * most users have installed: a real 0.4x table through the real analyzer and the real ArkType
 * generator, with the emitted module imported and run.
 *
 * This is the read-path defect as the quickstarts hit it. On 0.4x the column class does not move
 * when `{ unsigned: true }` is set, only `config.unsigned` does, and the class-name range table
 * never read it, so `int('x', { unsigned: true })` emitted the signed int32 range and the select
 * schema refused every stored value in [2^31, 2^32-1]. MySQL 8.4.11 stores 4294967295 in that
 * column and hands it back; the schema called the row invalid. `serial` was worse: its class was
 * in no range table at all, so an auto-increment column accepted -1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type } from 'arktype';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { ArkTypeGenerator } from '../src/index';

const DIR = path.join(__dirname, '.tmp-unsigned-int-ranges');

const SCHEMA = `
  import { mysqlTable, tinyint, int, bigint, serial } from 'drizzle-orm/mysql-core';
  export const t = mysqlTable('t', {
    ti_u: tinyint('ti_u', { unsigned: true }).notNull(),
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
  await new ArkTypeGenerator(analysis).generate({ outDir: DIR } as never);
  const emitted = path.join(DIR, `t-${process.pid}.ts`);
  await fs.rename(path.join(DIR, 't.arktype.ts'), emitted);
  mod = await import(emitted);
}, 120_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

const ok = (schema: any, field: string, value: unknown) =>
  !(schema.get(field)(value) instanceof type.errors);

describe('the stored maximum comes back through the select schema', () => {
  it('tinyint unsigned takes 255', () => {
    expect(ok(mod.SelecttSchema, 'ti_u', 255)).toBe(true);
    expect(ok(mod.SelecttSchema, 'ti_u', 256)).toBe(false);
    expect(ok(mod.SelecttSchema, 'ti_u', -1)).toBe(false);
  });

  it('int unsigned takes 4294967295, the value the defect report stored', () => {
    expect(ok(mod.SelecttSchema, 'i_u', 4294967295)).toBe(true);
    expect(ok(mod.SelecttSchema, 'i_u', 0)).toBe(true);
    expect(ok(mod.SelecttSchema, 'i_u', -1)).toBe(false);
    expect(ok(mod.SelecttSchema, 'i_u', 4294967296)).toBe(false);
  });

  it('bigint unsigned in bigint mode takes 2^64-1 exactly', () => {
    expect(ok(mod.SelecttSchema, 'b64_u', 18446744073709551615n)).toBe(true);
    expect(ok(mod.SelecttSchema, 'b64_u', -1n)).toBe(false);
    expect(ok(mod.SelecttSchema, 'b64_u', 18446744073709551616n)).toBe(false);
  });

  it('serial is bounded at last: zero up to the safe-integer ceiling', () => {
    expect(ok(mod.SelecttSchema, 'ser', 1)).toBe(true);
    expect(ok(mod.SelecttSchema, 'ser', 9007199254740991)).toBe(true);
    expect(ok(mod.SelecttSchema, 'ser', -1)).toBe(false);
  });
});

describe('the write direction of the same fact', () => {
  it('the insert schema refuses -1 and takes the stored maximum', () => {
    expect(ok(mod.InserttSchema, 'i_u', -1)).toBe(false);
    expect(ok(mod.InserttSchema, 'i_u', 4294967295)).toBe(true);
  });
});
