/**
 * MySQL/SingleStore `binary(n)`/`varbinary(n)`, by running the emitted schemas.
 *
 * Everything asserted here was asked of MySQL 8.4 through drizzle on both majors first, and the
 * two measurements pull the cap in opposite directions:
 *
 *   select   `<ff ff ff>` stored in a varbinary(3) comes back as 3 code points that re-encode to
 *            9 UTF-8 bytes, so a byte cap on a select schema rejects a row the column returned.
 *   insert   a varbinary(8) takes 8 ascii characters and refuses 9, and takes 2 emoji (8 bytes)
 *            and refuses 3 (12 bytes), so a character cap on an insert schema accepts a write the
 *            server refuses.
 *
 * Neither cap is right in both directions, which is why the column carries a shape rather than a
 * `maxLength`, and why this file runs each mode separately.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return await import(file);
}

const ok = (schema: any, v: unknown) => schema.safeParse({ vbin: v }).success;

/** Exactly what drizzle handed back for a varbinary(3) holding those three bytes. */
const SELECTED_FF = Buffer.from([0xff, 0xff, 0xff]).toString();
const EMOJI = '\u{1F600}';

describe('a byte-string select schema', () => {
  it('accepts the string the column returns, whatever bytes were stored', async () => {
    const m = await schemasFor(col(3));
    expect([...SELECTED_FF].length, '3 code points').toBe(3);
    expect(new TextEncoder().encode(SELECTED_FF).length, 'and 9 UTF-8 bytes').toBe(9);
    expect(ok(m.SelecttSchema, SELECTED_FF), 'a real row out of varbinary(3)').toBe(true);
    expect(ok(m.SelecttSchema, 'ABC'), 'ascii out of the same column').toBe(true);
    expect(ok(m.SelecttSchema, ''), 'an empty varbinary').toBe(true);
    // Not a bit string. The server takes any bytes at all and the driver decodes them as they
    // came, so `^[01]*$` refused every row that was not a run of 0 and 1.
    expect(ok(m.SelecttSchema, 'zzz'), 'three bytes that are not 0 or 1').toBe(true);
  });

  it('rejects the bytes themselves, which is not what the caller receives', async () => {
    // drizzle maps the driver's Buffer to a string before the caller sees it, measured on both
    // majors: `instanceof Uint8Array` is false for every one of these columns.
    const m = await schemasFor(col(3));
    expect(ok(m.SelecttSchema, Buffer.from([1, 2, 3]))).toBe(false);
    expect(ok(m.SelecttSchema, new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it('holds the row to the code points the column can return', async () => {
    // A lossy decode of n bytes yields at most n code points, so this never turns away a row and
    // still states the width.
    const m = await schemasFor(col(3));
    expect(ok(m.SelecttSchema, 'ABCD'), 'four code points out of a varbinary(3)').toBe(false);
  });
});

describe('a byte-string insert schema', () => {
  it('counts the bytes the server counts', async () => {
    const m = await schemasFor(col(8));
    expect(ok(m.InserttSchema, 'abcdefgh'), '8 bytes').toBe(true);
    expect(ok(m.InserttSchema, 'abcdefghi'), '9 bytes, ER_DATA_TOO_LONG').toBe(false);
  });

  it('refuses a write the server refuses even though it is short enough in characters', async () => {
    // The measurement that decides this: 3 emoji is 3 code points and 12 bytes, and a varbinary(8)
    // refuses it. A character cap accepts it, which is the over-acceptance a byte cap closes.
    const m = await schemasFor(col(8));
    expect(ok(m.InserttSchema, EMOJI.repeat(2)), '2 code points, 8 bytes').toBe(true);
    expect(ok(m.InserttSchema, EMOJI.repeat(3)), '3 code points, 12 bytes').toBe(false);
  });

  it('applies the same byte budget on update', async () => {
    const m = await schemasFor(col(8));
    expect(ok(m.UpdatetSchema, EMOJI.repeat(2))).toBe(true);
    expect(ok(m.UpdatetSchema, EMOJI.repeat(3))).toBe(false);
  });

  it('takes any bytes at all inside the budget', async () => {
    const m = await schemasFor(col(8));
    expect(ok(m.InserttSchema, ''), 'the empty string, which the server stores').toBe(true);
    expect(ok(m.InserttSchema, 'zzz'), 'not a run of 0 and 1').toBe(true);
  });
});

describe('a byte-string column with no declared width', () => {
  it('is a plain string in every mode rather than an unbounded regex', async () => {
    const m = await schemasFor(col(undefined));
    for (const s of [m.SelecttSchema, m.InserttSchema, m.UpdatetSchema]) {
      expect(ok(s, 'anything at all')).toBe(true);
      expect(ok(s, 42)).toBe(false);
    }
  });
});
