/**
 * Emitted schemas have to enforce what the column actually declares.
 *
 * Every target here was measured from `drizzle-orm/zod` at 1.0.0-rc.4 rather than guessed, by
 * building the schema and reading its checks:
 *
 *   varchar(255)         string, max_length <= 255
 *   char(4)              string, max_length <= 4
 *   uuid()               string, format uuid
 *   smallint()           safeint, -32768 .. 32767
 *   integer()            safeint, -2147483648 .. 2147483647
 *   bigint mode number   safeint, +/- 9007199254740991
 *   bigint mode bigint   bigint,  +/- 9223372036854775807
 *
 * DRZL emitted `z.string()` and `z.number().int()` for all of them, so a 300 character name and
 * a smallint of 40000 both passed validation and failed at the database. Being the codegen
 * alternative to a first-party runtime module is only defensible if the output is at least as
 * strict.
 */
import { describe, it, expect } from 'vitest';
import { ZodGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const col = (name: string, over: Partial<Column>): Column =>
  ({
    name,
    tsType: 'string',
    dbType: 'TEXT',
    nullable: false,
    hasDefault: false,
    isGenerated: false,
    ...over,
  }) as Column;

async function emit(columns: Column[]): Promise<string> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [] }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drzl-fid-'));
  await new ZodGenerator(analysis).generate({ outDir } as never);
  return fs.readFile(path.join(outDir, 't.zod.ts'), 'utf8');
}

/** The expression emitted for one field of the select schema. */
async function exprFor(over: Partial<Column>): Promise<string> {
  const src = await emit([col('x', over)]);
  const block = src.match(/SelecttSchema = z\.object\(\{([\s\S]*?)\n\}\)/)?.[1] ?? src;
  // Collapsed to one line first: prettier wraps a long expression across several, and a
  // line-based match would silently return only its first fragment.
  // Collapsed to one line, and the space prettier leaves before a wrapped `.` removed with
  // it, so the expectation reads as the expression would be written by hand.
  const flat = block.replace(/\s+/g, ' ').replace(/\s+\./g, '.').replace(/\(\s+/g, '(');
  const at = flat.indexOf('x: ');
  expect(at, `no field 'x' in:\n${src}`).toBeGreaterThanOrEqual(0);
  let i = at + 3;
  let depth = 0;
  const from = i;
  for (; i < flat.length; i++) {
    const ch = flat[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) break;
  }
  // Whitespace is prettier's to decide, so it is normalised away entirely.
  return flat.slice(from, i).trim();
}

describe('string length', () => {
  it('enforces a varchar limit, counting characters rather than UTF-16 units', async () => {
    // Deliberately not `.max(255)`, which is what `drizzle-orm/zod` emits. A `varchar(n)` limit
    // is n *characters*, and `.max` counts `.length`. Measured against Postgres for
    // `varchar(10)`: the database accepts eight emoji and `.max(10)` refuses them.
    expect(await exprFor({ tsType: 'string', maxLength: 255 })).toMatch(
      /^z\.string\(\)\.refine\(\(v\) => \[\.\.\.v\]\.length <= 255, \{ message: ['"]at most 255 characters['"] \}\)$/
    );
  });

  it('leaves an unbounded string alone', async () => {
    expect(await exprFor({ tsType: 'string' })).toBe('z.string()');
  });
});

describe('uuid', () => {
  it('emits z.uuid() rather than a bare string', async () => {
    expect(await exprFor({ tsType: 'string', dbType: 'UUID', format: 'uuid' })).toBe('z.uuid()');
  });

  it('does not also stack a length on it', async () => {
    // A uuid is fixed width by construction; `.max()` on top would be noise.
    const e = await exprFor({ tsType: 'string', dbType: 'UUID', format: 'uuid', maxLength: 36 });
    expect(e).toBe('z.uuid()');
  });
});

describe('integer range', () => {
  it('bounds a smallint', async () => {
    expect(
      await exprFor({ tsType: 'number', dbType: 'INTEGER', min: '-32768', max: '32767' })
    ).toBe('z.number().int().gte(-32768).lte(32767)');
  });

  it('bounds an integer', async () => {
    expect(
      await exprFor({ tsType: 'number', dbType: 'INTEGER', min: '-2147483648', max: '2147483647' })
    ).toBe('z.number().int().gte(-2147483648).lte(2147483647)');
  });

  it('treats a bounded bigint in number mode as an integer, not a bigint', async () => {
    // `bigint({ mode: 'number' })` yields a JS number. Emitting z.bigint() rejected every row.
    expect(
      await exprFor({
        tsType: 'number',
        dbType: 'BIGINT',
        min: '-9007199254740991',
        max: '9007199254740991',
      })
    ).toBe('z.number().int().gte(-9007199254740991).lte(9007199254740991)');
  });

  it('emits bigint literals for a 64 bit bound, which no number can hold', async () => {
    expect(
      await exprFor({
        tsType: 'bigint',
        dbType: 'BIGINT',
        min: '-9223372036854775808',
        max: '9223372036854775807',
      })
    ).toBe('z.bigint().gte(-9223372036854775808n).lte(9223372036854775807n)');
  });

  it('leaves a float unbounded', async () => {
    expect(await exprFor({ tsType: 'number', dbType: 'DOUBLE' })).toBe('z.number()');
  });
});

describe('composition with the rest of the schema', () => {
  it('applies nullability after the constraint', async () => {
    const e = await exprFor({ tsType: 'string', maxLength: 10, nullable: true });
    expect(e).toMatch(
      /^z\.string\(\)\.refine\(\(v\) => \[\.\.\.v\]\.length <= 10, \{ message: ['"]at most 10 characters['"] \}\)\.nullable\(\)$/
    );
  });

  it('still parses as TypeScript', async () => {
    const src = await emit([
      col('a', { tsType: 'string', maxLength: 255 }),
      col('b', { tsType: 'string', dbType: 'UUID', format: 'uuid' }),
      col('c', { tsType: 'number', dbType: 'INTEGER', min: '-32768', max: '32767' }),
      col('d', { tsType: 'bigint', dbType: 'BIGINT', min: '-1', max: '9223372036854775807' }),
    ]);
    const ts = await import('typescript');
    const sf = ts.createSourceFile('t.zod.ts', src, ts.ScriptTarget.ES2022, true);
    expect((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics ?? []).toHaveLength(
      0
    );
  });
});
