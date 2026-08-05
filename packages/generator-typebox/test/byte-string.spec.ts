/**
 * MySQL/SingleStore `binary(n)`/`varbinary(n)` in TypeBox, by running the emitted schemas.
 *
 * The measurements these assert are in `packages/generator-zod/test/byte-string.spec.ts` and were
 * taken from MySQL 8.4 through drizzle on both majors. `maxLength` counts UTF-16 code units, which
 * is neither the code points a select can return nor the bytes an insert is measured in, so both
 * caps go to the registered kind where an exact count can be written.
 */
import { describe, it, expect } from 'vitest';
import { TypeBoxGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Value } from '@sinclair/typebox/value';

const col = (length?: number): Column =>
  ({
    name: 'vbin',
    tsType: 'string',
    dbType: 'BINARY',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    shape: { kind: 'byteString', length },
  }) as Column;

let seq = 0;

async function schemasFor(c: Column) {
  const analysis: Analysis = {
    dialect: 'mysql',
    tables: [{ name: 't', tsName: 't', columns: [c], unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-bytestring');
  await fs.mkdir(dir, { recursive: true });
  await new TypeBoxGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.typebox.ts'), file);
  return await import(file);
}

const ok = (schema: any, x: unknown) => Value.Check(schema, { vbin: x });
const SELECTED_FF = Buffer.from([0xff, 0xff, 0xff]).toString();
const EMOJI = '\u{1F600}';

describe('typebox, a byte-string column', () => {
  it('accepts on select the row a varbinary(3) returns, 3 code points and 9 bytes', async () => {
    const m = await schemasFor(col(3));
    expect(ok(m.SelecttSchema, SELECTED_FF)).toBe(true);
    expect(ok(m.SelecttSchema, 'zzz'), 'not a run of 0 and 1').toBe(true);
    expect(ok(m.SelecttSchema, ''), 'an empty varbinary').toBe(true);
    expect(ok(m.SelecttSchema, 'ABCD'), 'four code points out of a varbinary(3)').toBe(false);
  });

  it('rejects the bytes, which drizzle decoded before the caller saw them', async () => {
    const m = await schemasFor(col(3));
    expect(ok(m.SelecttSchema, new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('counts bytes on insert and update, which is what the server counts', async () => {
    const m = await schemasFor(col(8));
    expect(ok(m.InserttSchema, 'abcdefgh'), '8 bytes').toBe(true);
    expect(ok(m.InserttSchema, 'abcdefghi'), '9 bytes').toBe(false);
    expect(ok(m.InserttSchema, EMOJI.repeat(2)), '2 code points, 8 bytes').toBe(true);
    expect(ok(m.InserttSchema, EMOJI.repeat(3)), '3 code points, 12 bytes').toBe(false);
    expect(ok(m.UpdatetSchema, EMOJI.repeat(3))).toBe(false);
  });

  it('is a plain string when the column declares no width', async () => {
    const m = await schemasFor(col(undefined));
    expect(ok(m.SelecttSchema, 'anything at all')).toBe(true);
    expect(ok(m.InserttSchema, 42)).toBe(false);
  });
});
