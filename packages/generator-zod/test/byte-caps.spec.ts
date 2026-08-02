/**
 * A MySQL TEXT cap is a byte budget, applied as one.
 *
 * Measured against MySQL 8 on utf8mb4: `tinytext` takes 255 ascii characters and 63 thumbs-up
 * characters (252 bytes), and refuses 64 of them (256 bytes). A character count cannot express
 * that, so the check encodes the string and counts the result.
 *
 * `varchar(n)` is genuinely characters and keeps counting code points, which is a different
 * measurement on the same column type in the same database.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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
    dialect: 'mysql',
    tables: [{ name: 't', tsName: 't', columns: [c], unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-bytecaps');
  await fs.mkdir(dir, { recursive: true });
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return (await import(file)).SelecttSchema;
}

const ok = (s: any, v: unknown) => s.safeParse({ n: v }).success;
const EMOJI = '\u{1F44D}';

describe('a byte cap', () => {
  it('counts bytes, so ascii fills it exactly', async () => {
    const s = await schemaFor(col({ maxBytes: 255 }));
    expect(ok(s, 'a'.repeat(255))).toBe(true);
    expect(ok(s, 'a'.repeat(256))).toBe(false);
  });

  it('counts bytes, so four-byte characters fill it four times as fast', async () => {
    // This is the whole point. 64 emoji is 64 characters and 256 bytes: MySQL refuses the row,
    // and a character count would have accepted it.
    const s = await schemaFor(col({ maxBytes: 255 }));
    expect(ok(s, EMOJI.repeat(63)), '252 bytes').toBe(true);
    expect(ok(s, EMOJI.repeat(64)), '256 bytes').toBe(false);
  });

  it('leaves a character cap counting characters', async () => {
    // `varchar(10)` really is ten characters in MySQL, verified against the server.
    const s = await schemaFor(col({ maxLength: 10 }));
    expect(ok(s, EMOJI.repeat(10))).toBe(true);
    expect(ok(s, EMOJI.repeat(11))).toBe(false);
  });

  it('applies both when a column somehow has both', async () => {
    const s = await schemaFor(col({ maxLength: 10, maxBytes: 20 }));
    expect(ok(s, 'a'.repeat(10)), '10 chars, 10 bytes').toBe(true);
    expect(ok(s, 'a'.repeat(11)), 'over the character cap').toBe(false);
    expect(ok(s, EMOJI.repeat(6)), '6 chars but 24 bytes').toBe(false);
  });
});
