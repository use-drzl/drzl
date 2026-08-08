/**
 * `CHECK (octet_length(col) <= 5)` in TypeBox output.
 *
 * See the zod generator's file of the same name for the PGlite measurements this is written
 * against. TypeBox carries the count in the registered kind the row checks use, for the reason
 * `length.spec` gives: `maxLength` counts UTF-16 units, and a byte budget is a third measurement
 * again.
 */
import { describe, it, expect } from 'vitest';
import { TypeBoxGenerator } from '../src/index';
import type { Analysis, Column } from '@drzl/analyzer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Value } from '@sinclair/typebox/value';

const GRIN = '\u{1F600}';

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

const blob = (name = 'blob') =>
  col(name, { tsType: 'Uint8Array', dbType: 'BYTEA', shape: { kind: 'buffer' } as never });

let seq = 0;
let lastFile = '';

async function schemasFor(columns: Column[], checks: unknown[]): Promise<Record<string, any>> {
  const analysis: Analysis = {
    dialect: 'postgres',
    tables: [{ name: 't', tsName: 't', columns, unique: [], indexes: [], checks }] as never,
    enums: [],
    relations: [],
    issues: [],
  };
  const dir = path.join(__dirname, '.tmp-octets');
  await fs.mkdir(dir, { recursive: true });
  await new TypeBoxGenerator(analysis).generate({ outDir: dir } as never);
  lastFile = path.join(dir, `t-${process.pid}-${seq++}.ts`);
  await fs.rename(path.join(dir, 't.typebox.ts'), lastFile);
  return await import(lastFile);
}

describe('a byte budget on a text column', () => {
  it('accepts and refuses exactly what Postgres did', async () => {
    const m = await schemasFor([col('body')], [{ expression: 'octet_length(body) <= 5' }]);
    expect(Value.Check(m.SelecttSchema, { body: 'hello' }), 'five ascii').toBe(true);
    expect(Value.Check(m.SelecttSchema, { body: 'hellos' }), 'six ascii').toBe(false);
    expect(Value.Check(m.SelecttSchema, { body: GRIN }), 'one emoji, four bytes').toBe(true);
    expect(Value.Check(m.SelecttSchema, { body: GRIN.repeat(2) }), 'two emoji, eight bytes').toBe(
      false
    );
  });

  it('names the constraint in the branch description', async () => {
    await schemasFor(
      [col('body')],
      [{ name: 'body_bytes', expression: 'octet_length(body) <= 5' }]
    );
    expect(await fs.readFile(lastFile, 'utf8')).toContain('body_bytes: octet_length(body) <= 5');
  });
});

describe('a byte budget on a bytea column', () => {
  it('counts the array, which is what Postgres counted', async () => {
    const m = await schemasFor([blob()], [{ expression: 'octet_length(blob) <= 5' }]);
    expect(Value.Check(m.SelecttSchema, { blob: new Uint8Array(5) })).toBe(true);
    expect(Value.Check(m.SelecttSchema, { blob: new Uint8Array(6) })).toBe(false);
  });
});

describe('a byte budget on a column that cannot answer one', () => {
  it('emits nothing for a MySQL varbinary', async () => {
    const bin = col('bin', {
      dbType: 'VARBINARY',
      shape: { kind: 'byteString', length: 8 } as never,
    });
    await schemasFor([bin], [{ expression: 'octet_length(bin) <= 5' }]);
    expect(await fs.readFile(lastFile, 'utf8')).not.toContain('octet_length(bin)');
  });

  it('drags in no kind registration for a count it does not emit', async () => {
    // The registered kind is imported only where a branch uses it, so `needsRows` and
    // `tbLengthBranches` have to answer the same question. A customType column is the case that
    // isolates it: it answers no count *and* declares no cap, so the import has no other reason.
    const custom = col('c', { tsType: 'unknown', shape: { kind: 'custom' } as never });
    await schemasFor([custom], [{ expression: 'octet_length(c) <= 5' }]);
    const src = await fs.readFile(lastFile, 'utf8');
    expect(src).not.toContain('octet_length(c)');
    expect(src).not.toContain('TypeRegistry');
  });
});
