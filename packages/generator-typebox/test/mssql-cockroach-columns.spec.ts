/**
 * The two mssql and cockroach columns whose description changed, run through TypeBox.
 *
 * Built by the real column builders, described by the real analyzer, emitted by the real
 * generator, then imported and executed. Nothing here reads the emitted text: a schema that
 * parses is not a schema that validates, and TypeBox in particular will accept an option it does
 * not understand for a given type and then ignore it, which is why this package checks by running.
 *
 * Both paths, deliberately. `Value.Check` walks the schema and `TypeCompiler` generates a checker
 * from it, and they are two different implementations of the same question: a constraint the
 * compiler does not emit code for passes `Value.Check` and validates nothing in the code a user
 * actually runs.
 *
 * Every value below is one a server took or refused. See the header of
 * `packages/analyzer/test/mssql-cockroach-columns.spec.ts` for the two readings in full: SQL
 * Server 2022 on a `tinyint`, and CockroachDB v24.3.5 on a `bit(3)` and a `varbit(8)`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SchemaAnalyzer, type Analysis, type Column } from '@drzl/analyzer';
import { Value } from '@sinclair/typebox/value';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { TypeBoxGenerator } from '../src/index';

const dir = path.join(__dirname, '.tmp-mssql-cockroach');

const MSSQL_SOURCE = `
  import { mssqlTable, int, tinyint, varchar } from 'drizzle-orm-v1/mssql-core';
  export const t = mssqlTable('t', {
    id: int('id'),
    ti: tinyint('ti'),
    name: varchar('name', { length: 120 }),
  });
`;

const COCKROACH_SOURCE = `
  import { cockroachTable, bit, boolean, text, varbit } from 'drizzle-orm-v1/cockroach-core';
  export const t = cockroachTable('t', {
    flag: boolean('flag'),
    body: text('body'),
    bt: bit('bt', { length: 3 }),
    vb: varbit('vb', { length: 8 }),
  });
`;

interface Emitted {
  byName: Map<string, Column>;
  schemas: Record<string, { properties: Record<string, unknown> }>;
}

const cache = new Map<string, Emitted>();

async function dialect(name: string, source: string): Promise<Emitted> {
  const hit = cache.get(name);
  if (hit) return hit;
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.schema.mjs`);
  await fs.writeFile(file, source, 'utf8');
  const analysis: Analysis = await new SchemaAnalyzer(path.relative(process.cwd(), file)).analyze(
    {}
  );
  const table = analysis.tables[0];
  expect(table, `no table analyzed; issues: ${JSON.stringify(analysis.issues)}`).toBeTruthy();

  const outDir = path.join(dir, `${name}-out`);
  await new TypeBoxGenerator(analysis).generate({ outDir } as never);
  const emitted = path.join(outDir, `t-${process.pid}.ts`);
  await fs.rename(path.join(outDir, 't.typebox.ts'), emitted);
  const schemas = await import(emitted);

  const out: Emitted = { byName: new Map(table.columns.map((c) => [c.name, c])), schemas };
  cache.set(name, out);
  return out;
}

const mssql = () => dialect('mssql', MSSQL_SOURCE);
const cockroach = () => dialect('cockroach', COCKROACH_SOURCE);

/** The select-side field for one column, checked by walking the schema. */
const walks = (e: Emitted, col: string, v: unknown) =>
  Value.Check(e.schemas.SelecttSchema.properties[col] as never, v);

/** The same field, checked by the code TypeCompiler generates from it. */
const compiles = (e: Emitted, col: string, v: unknown) =>
  TypeCompiler.Compile(e.schemas.SelecttSchema.properties[col] as never).Check(v);

/** Both paths must agree, and the agreed answer is what is asserted. */
function accepts(e: Emitted, col: string, v: unknown, why: string): boolean {
  const a = walks(e, col, v);
  const b = compiles(e, col, v);
  expect(b, `${col}: Value.Check and TypeCompiler disagree on ${why}`).toBe(a);
  return a;
}

beforeAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('mssql tinyint, through the emitted TypeBox schema', () => {
  it('takes what SQL Server stored and refuses what it turned away', async () => {
    const a = await mssql();
    expect(a.byName.get('ti')).toMatchObject({
      tsType: 'number',
      dbType: 'TINYINT',
      integer: true,
      min: '0',
      max: '255',
    });
    expect(accepts(a, 'ti', 0, 'the 0 the server stored')).toBe(true);
    expect(accepts(a, 'ti', 200, 'a value inside the width')).toBe(true);
    expect(accepts(a, 'ti', 255, 'the 255 the server stored')).toBe(true);
    expect(accepts(a, 'ti', -1, 'refused with Msg 220')).toBe(false);
    expect(accepts(a, 'ti', 256, 'refused with Msg 220')).toBe(false);
    expect(accepts(a, 'ti', 9007199254740991, 'refused with Msg 8115')).toBe(false);
    expect(accepts(a, 'ti', 3.7, 'a fraction, which the column never returns')).toBe(false);
    expect(accepts(a, 'ti', '5', 'a string in a numeric column')).toBe(false);
  });

  it('leaves the columns beside it alone', async () => {
    // A guard against a fix that reaches further than its column: `int` keeps the 32 bit width
    // and `varchar(120)` keeps its cap.
    const a = await mssql();
    expect(accepts(a, 'id', -2147483648, 'the bottom of an int32')).toBe(true);
    expect(accepts(a, 'id', 2147483648, 'past the top of an int32')).toBe(false);
    expect(accepts(a, 'name', 'a'.repeat(120), 'the longest value the server took')).toBe(true);
    expect(accepts(a, 'name', 'a'.repeat(121), 'the value the server refused')).toBe(false);
  });
});

describe('cockroach bit and varbit, through the emitted TypeBox schema', () => {
  it('holds a bit(3) to exactly three digits', async () => {
    const a = await cockroach();
    expect(a.byName.get('bt')?.shape).toEqual({ kind: 'bitstring', length: 3, exact: true });
    expect(accepts(a, 'bt', '101', 'the value the server returned')).toBe(true);
    expect(accepts(a, 'bt', '', 'refused, length 0 does not match BIT(3)')).toBe(false);
    expect(accepts(a, 'bt', '1', 'refused, length 1 does not match BIT(3)')).toBe(false);
    expect(accepts(a, 'bt', '10', 'refused, length 2 does not match BIT(3)')).toBe(false);
    expect(accepts(a, 'bt', '1011', 'refused, length 4 does not match BIT(3)')).toBe(false);
    expect(accepts(a, 'bt', '102', 'a digit that is neither 0 nor 1')).toBe(false);
    expect(accepts(a, 'bt', 101, 'a number rather than the string the driver returns')).toBe(false);
  });

  it('holds a varbit(8) to at most eight', async () => {
    const a = await cockroach();
    expect(a.byName.get('vb')?.shape).toEqual({ kind: 'bitstring', length: 8, exact: false });
    expect(accepts(a, 'vb', '', 'the empty string the server accepted')).toBe(true);
    expect(accepts(a, 'vb', '1', 'one digit, which varbit takes')).toBe(true);
    expect(accepts(a, 'vb', '10101010', 'the value the server returned')).toBe(true);
    expect(accepts(a, 'vb', '101010101', 'nine digits, past the declared width')).toBe(false);
  });

  it('keeps the boolean and string families the two dialects lost', async () => {
    // The families the filed defect was about, checked here through the second generator and the
    // second checking path rather than taken on trust from the zod suite.
    const a = await cockroach();
    expect(accepts(a, 'flag', true, 'the true the server returned')).toBe(true);
    expect(accepts(a, 'flag', 1, 'the integer the server refused')).toBe(false);
    expect(accepts(a, 'flag', 'yes', 'a string in a bool column')).toBe(false);
    expect(accepts(a, 'body', 'body text', 'a row the server returned')).toBe(true);
    expect(accepts(a, 'body', 12345, 'a number in a string column')).toBe(false);
  });
});
