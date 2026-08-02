/**
 * String caps in ArkType: characters for `varchar(n)`, bytes for MySQL's TEXT family.
 *
 * `string <= 10` counts UTF-16 code units. Both Postgres and MySQL count `varchar(10)` in
 * characters, verified against both servers, so ten thumbs-up characters are a valid row and
 * ArkType refused it. That is the over-strict direction: it turns away rows the database takes.
 *
 * MySQL's TEXT family is a byte budget instead: `tinytext` takes 255 ascii characters and 63
 * thumbs-up ones. Neither is expressible in the string DSL, so both go where an exact count can
 * be written, a narrow on the object.
 */
import { describe, it, expect } from 'vitest';
import { ArkTypeGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type } from 'arktype';

const col = (over: Partial<Column> = {}): Column =>
  ({
    name: 'n',
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

let seq = 0;

async function schemaFor(c: Column) {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns: [c], unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-caps');
  await fs.mkdir(dir, { recursive: true });
  await new ArkTypeGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.arktype.ts'), file);
  return (await import(file)).SelecttSchema;
}

const ok = (s: any, v: unknown) => !(s({ n: v }) instanceof type.errors);
const EMOJI = '\u{1F44D}';

describe('a character cap', () => {
  it('counts characters, so ten emoji fit a varchar(10)', async () => {
    const s = await schemaFor(col({ maxLength: 10 }));
    expect(ok(s, EMOJI.repeat(10)), 'accepted by both databases').toBe(true);
    expect(ok(s, EMOJI.repeat(11))).toBe(false);
    expect(ok(s, 'a'.repeat(10))).toBe(true);
    expect(ok(s, 'a'.repeat(11))).toBe(false);
  });
});

describe('a byte cap', () => {
  it('counts bytes, so a four-byte character fills it four times as fast', async () => {
    const s = await schemaFor(col({ maxBytes: 255 }));
    expect(ok(s, 'a'.repeat(255))).toBe(true);
    expect(ok(s, 'a'.repeat(256))).toBe(false);
    expect(ok(s, EMOJI.repeat(63)), '252 bytes').toBe(true);
    expect(ok(s, EMOJI.repeat(64)), '256 bytes').toBe(false);
  });
});

describe('a column with neither', () => {
  it('is a bare string', async () => {
    const s = await schemaFor(col());
    expect(ok(s, 'x'.repeat(100000))).toBe(true);
  });
});

describe('an array of capped strings', () => {
  it('caps the element, not the array', async () => {
    // `varchar(50).array()` limits each element. Dropping the cap because the column is an array
    // is how the first version of this went: the field is the array, and the cap describes what
    // is in it.
    const s = await schemaFor(col({ maxLength: 3, arrayDimensions: 1, tsType: 'string' }));
    expect(ok(s, ['ab', 'abc'])).toBe(true);
    expect(ok(s, ['abcd'])).toBe(false);
    expect(ok(s, [EMOJI.repeat(3)]), '3 characters').toBe(true);
    expect(ok(s, []), 'an empty array is fine').toBe(true);
  });
});
