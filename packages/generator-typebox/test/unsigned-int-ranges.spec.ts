/**
 * Unsigned MySQL integers, end to end: a real drizzle v1 table through the real analyzer and the
 * real TypeBox generator, with the emitted module imported and both checkers run: `Value.Check`
 * and the compiler, whose preflight refuses schemas `Value.Check` would let slide.
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
import { Value } from '@sinclair/typebox/value';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { SchemaAnalyzer } from '@drzl/analyzer';
import { TypeBoxGenerator } from '../src/index';

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
  await new TypeBoxGenerator(analysis).generate({ outDir: DIR } as never);
  const emitted = path.join(DIR, `t-${process.pid}.ts`);
  await fs.rename(path.join(DIR, 't.typebox.ts'), emitted);
  mod = await import(emitted);
}, 120_000);

afterAll(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

/** Both checkers must agree, so a bound the compiler preflight rejects cannot hide. */
const ok = (schema: any, value: unknown) => {
  const plain = Value.Check(schema, value);
  const compiled = TypeCompiler.Compile(schema).Check(value);
  expect(compiled, 'Value.Check and TypeCompiler disagree').toBe(plain);
  return plain;
};

describe('int unsigned, on the select path', () => {
  it('takes every value the column stores, to the top', () => {
    const s = mod.SelecttSchema.properties.i_u;
    expect(ok(s, 0)).toBe(true);
    expect(ok(s, 4294967295), 'the stored maximum of an int unsigned').toBe(true);
  });

  it('refuses what the column cannot hold', () => {
    const s = mod.SelecttSchema.properties.i_u;
    expect(ok(s, -1), 'below the unsigned floor').toBe(false);
    expect(ok(s, 4294967296), 'above the unsigned ceiling').toBe(false);
    expect(ok(s, 1.5), 'an integer column').toBe(false);
  });

  it('refuses -1 on insert too, which is the write half of the same fact', () => {
    const s = mod.InserttSchema.properties.i_u;
    expect(ok(s, -1)).toBe(false);
    expect(ok(s, 4294967295)).toBe(true);
  });
});

describe('bigint unsigned in bigint mode, whose ceiling a bigint can spell exactly', () => {
  it('takes the stored maximum back and refuses beyond either edge', () => {
    const s = mod.SelecttSchema.properties.b64_u;
    expect(ok(s, 0n)).toBe(true);
    expect(ok(s, 18446744073709551615n), 'the stored maximum, 2^64-1').toBe(true);
    expect(ok(s, -1n)).toBe(false);
    expect(Value.Check(s, 18446744073709551616n)).toBe(false);
    expect(ok(s, 4), 'a number never arrives on this wire').toBe(false);
  });

  it('pins the one probe the two checkers split on, so a TypeBox fix reports itself', () => {
    // TypeCompiler 0.34.52 renders a bigint bound as `BigInt(<number literal>)`, measured with
    // `TypeCompiler.Code`: the ceiling here compiles to `value <= BigInt(18446744073709551615)`,
    // and that number literal is a double that rounds up to 2^64, so the compiled checker takes
    // 18446744073709551616n where `Value.Check`, comparing against the schema's own bigint,
    // refuses it. Not this generator's emission and not new with unsigned: the signed ceiling
    // compiles to `BigInt(9223372036854775807)` and rounds to 2^63 the same way, measured on the
    // same installed TypeBox before this fix existed. When a TypeBox release makes this
    // expectation fail, the pin has done its job: delete it and fold the probe into `ok` above.
    const s = mod.SelecttSchema.properties.b64_u;
    expect(Value.Check(s, 18446744073709551616n)).toBe(false);
    expect(TypeCompiler.Compile(s).Check(18446744073709551616n)).toBe(true);
  });
});

describe('serial, which is bigint unsigned auto_increment under a shorter name', () => {
  it('starts at zero and stops at the safe-integer ceiling its number mode imposes', () => {
    const s = mod.SelecttSchema.properties.ser;
    expect(ok(s, 1)).toBe(true);
    expect(ok(s, 9007199254740991)).toBe(true);
    expect(ok(s, -1)).toBe(false);
  });
});
