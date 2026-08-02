/**
 * A `varchar(n)` limit counts characters, not UTF-16 code units.
 *
 * Postgres and MySQL count `varchar(n)` in characters. Every JavaScript validator counts
 * `.length`, which is UTF-16 code units. The two agree until the text leaves the basic plane, and
 * then they do not, so `z.string().max(10)` refuses eight emoji that `varchar(10)` accepts.
 *
 * Measured against Postgres through PGlite, for `varchar(10)`:
 *
 *    3 emoji   db accepts    .max(10) accepts
 *    8 emoji   db accepts    .max(10) REFUSES
 *   10 emoji   db accepts    .max(10) REFUSES
 *   11 emoji   db refuses    .max(10) refuses
 *
 * `[...v].length` counts code points, which is what the database counts, and agrees on all four.
 * `drizzle-orm/zod` emits `.max(n)` and refuses the middle two.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const THUMB = '\u{1F44D}'; // one code point, two UTF-16 units

const col = (name: string, over: Partial<Column> = {}): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

let seq = 0;

async function schemasFor(columns: Column[]): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-charlen');
  await fs.mkdir(dir, { recursive: true });
  await new ZodGenerator(analysis).generate({ outDir: dir } as never);
  const file = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.zod.ts'), file);
  return await import(file);
}

describe('a varchar(10) column', () => {
  it('accepts what the database accepts, emoji included', async () => {
    const m = await schemasFor([col('name', { maxLength: 10 })]);
    const f = m.SelecttSchema.shape.name;

    expect(f.safeParse('abcdefghij').success, 'ten plain characters').toBe(true);
    expect(f.safeParse('abcdefghijk').success, 'eleven plain characters').toBe(false);

    // The cases `.max(10)` gets wrong: eight emoji are eight characters to the database and
    // sixteen UTF-16 units to JavaScript.
    expect(f.safeParse(THUMB.repeat(8)).success, 'eight emoji, which the database accepts').toBe(
      true
    );
    expect(f.safeParse(THUMB.repeat(10)).success, 'ten emoji, exactly at the limit').toBe(true);
    expect(f.safeParse(THUMB.repeat(11)).success, 'eleven emoji, past the limit').toBe(false);
  });

  it('counts a combining sequence the way the database does', async () => {
    // A family emoji is five code points joined by zero-width joiners. Postgres counts five.
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    expect([...family].length, 'five code points').toBe(5);
    expect(family.length, 'eight UTF-16 units').toBe(8);

    const m = await schemasFor([col('name', { maxLength: 5 })]);
    expect(m.SelecttSchema.shape.name.safeParse(family).success).toBe(true);
  });

  it('leaves an unbounded string alone', async () => {
    const m = await schemasFor([col('bio')]);
    expect(m.SelecttSchema.shape.bio.safeParse(THUMB.repeat(500)).success).toBe(true);
  });
});
